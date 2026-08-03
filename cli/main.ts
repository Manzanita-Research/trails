import { Effect, Fiber } from "effect"
import { runCollection } from "../collector/sync"
import { DEFAULT_STATE_PATH } from "../collector/state"
import { parseSourceRoot } from "../collector/sources"
import {
  configureCollector,
  configureServer,
  loadCollectorConfig,
  loadServerConfig,
} from "./config"
import { join, resolve } from "node:path"
import { createApp } from "../server/app"
import { DEFAULT_DB_PATH, openDatabase } from "../server/db"
import { createInferenceClient, summarySupervisor } from "../server/summaries"
import { createBackup } from "../server/backup"
import { install } from "./install"

const VERSION = "0.1.0"

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function valuesAfter(args: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1])
  }
  return values
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("port must be between 1 and 65535")
  return port
}

function printUsage(): void {
  console.log(`trails ${VERSION}

Commands:
  serve [--db PATH] [--port PORT] [--api-only] [--static-dir PATH]
  collect --once [--server URL] [--device-id ID] [--device-name NAME] [--state PATH]
  configure collector --server URL [--name NAME] [--reset-device-id]
  configure server --ai-url URL --ai-token-stdin
  backup --output PATH | --output-dir DIR [--retain 14] [--db PATH]
  install server|collector [--dry-run]
  version`)
}

async function serve(args: string[]): Promise<void> {
  const host = valueAfter(args, "--host") ?? "127.0.0.1"
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("trails serve only binds to a loopback host")
  }
  const port = parsePort(valueAfter(args, "--port") ?? process.env.TRAILS_PORT ?? "7412")
  const dbPath = valueAfter(args, "--db") ?? process.env.TRAILS_DB_PATH ?? DEFAULT_DB_PATH
  const apiOnly = args.includes("--api-only")
  const staticOverride = valueAfter(args, "--static-dir")
  const standalone = "isStandaloneExecutable" in Bun
    ? Bun.isStandaloneExecutable === true
    : Bun.main.startsWith("/$bunfs/")
  if (standalone && staticOverride) throw new Error("--static-dir is available only in source mode")
  const staticRoot = apiOnly
    ? undefined
    : staticOverride
      ? resolve(staticOverride)
      : standalone
        ? join(import.meta.dir, "dist/client")
        : resolve("dist/client")
  const staticAssets = standalone
    ? Bun.embeddedFiles.filter(
        (asset): asset is Blob & { readonly name: string } =>
          "name" in asset && typeof asset.name === "string",
      )
    : undefined
  const serverConfig = loadServerConfig()
  const inference = serverConfig
    ? { url: serverConfig.aiUrl, token: serverConfig.aiToken }
    : undefined
  const db = openDatabase(dbPath)
  const app = createApp({ db, staticRoot, staticAssets, inference })
  const server = Bun.serve({ hostname: host, port, fetch: app })
  const summaryFiber = inference
    ? Effect.runFork(summarySupervisor({ db, inference: createInferenceClient(inference) }))
    : null
  const shutdown = () => {
    server.stop(true)
    if (summaryFiber) Effect.runFork(Fiber.interrupt(summaryFiber))
    db.close()
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  console.log(`trails serving on http://${host}:${server.port}`)
}

async function collect(args: string[]): Promise<void> {
  if (!args.includes("--once")) throw new Error("collect currently requires --once")
  const config = loadCollectorConfig()
  const server = valueAfter(args, "--server") ?? config?.server
  const deviceId = valueAfter(args, "--device-id") ?? config?.deviceId
  const deviceName = valueAfter(args, "--device-name") ?? config?.deviceName
  if (!server || !deviceId || !deviceName) {
    throw new Error("collector server and device identity are not configured")
  }
  const sourceRoots = valuesAfter(args, "--source-root")
  const result = await Effect.runPromise(
    runCollection({
      server,
      deviceId,
      deviceName,
      statePath: resolve(valueAfter(args, "--state") ?? DEFAULT_STATE_PATH),
      roots: sourceRoots.length ? sourceRoots.map(parseSourceRoot) : undefined,
    }),
  )
  console.log(
    `collected ${result.uploaded}, unchanged ${result.unchanged}, ignored ${result.ignored}, revision ${result.revision ?? "unchanged"}`,
  )
}

async function configure(args: string[]): Promise<void> {
  if (args[0] === "collector") {
    const server = valueAfter(args, "--server")
    if (!server) throw new Error("configure collector requires --server")
    const config = configureCollector({
      server,
      name: valueAfter(args, "--name"),
      resetDeviceId: args.includes("--reset-device-id"),
    })
    console.log(`configured collector ${config.deviceName} (${config.deviceId}) for ${config.server}`)
    return
  }
  if (args[0] === "server") {
    const aiUrl = valueAfter(args, "--ai-url")
    if (!aiUrl || !args.includes("--ai-token-stdin")) {
      throw new Error("configure server requires --ai-url and --ai-token-stdin")
    }
    const config = configureServer({ aiUrl, aiToken: await Bun.stdin.text() })
    console.log(`configured AI relay ${config.aiUrl}`)
    return
  }
  throw new Error("configure requires collector or server")
}

async function backup(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("trails backup --output PATH | --output-dir DIR [--retain 14] [--db PATH]")
    return
  }
  const output = valueAfter(args, "--output")
  const outputDir = valueAfter(args, "--output-dir")
  const retainValue = valueAfter(args, "--retain")
  const retain = retainValue === undefined ? undefined : Number(retainValue)
  const path = await createBackup({
    dbPath: valueAfter(args, "--db") ?? process.env.TRAILS_DB_PATH,
    output,
    outputDir,
    retain,
  })
  console.log(`wrote backup ${path}`)
}

async function installCommand(args: string[]): Promise<void> {
  if (args[0] !== "server" && args[0] !== "collector") throw new Error("install requires server or collector")
  await install({ kind: args[0], dryRun: args.includes("--dry-run") })
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  if (command === "serve") return serve(args.slice(1))
  if (command === "collect") return collect(args.slice(1))
  if (command === "configure") return configure(args.slice(1))
  if (command === "backup") return backup(args.slice(1))
  if (command === "install") return installCommand(args.slice(1))
  if (command === "version") {
    console.log(VERSION)
    return
  }
  if (command === "help" || command === "--help" || command === "-h" || command === undefined) {
    printUsage()
    return
  }
  throw new Error(`unknown command: ${command}`)
}

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
