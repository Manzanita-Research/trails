import { terminalText } from "../shared/terminal"
import { runAuthCommand } from "./auth"
import { initializeOwner, issueCredential, credentialFor, ownerTokenPath } from "../server/auth"
import packageJson from "../package.json" with { type: "json" }
import { Effect, Fiber } from "effect"
import { runCollection } from "../collector/sync"
import { DEFAULT_STATE_PATH } from "../collector/state"
import { parseSourceRoot } from "../collector/sources"
import { atomicWriteJson, COLLECTOR_CONFIG_PATH, importCollectorPairing, configureCollector, loadCollectorConfig, normalizeCollectorServer } from "./config"
import { join, resolve } from "node:path"
import { createApp, setAdvertisedHubUrl } from "../server/app"
import { localOrigins, normalizeTrustedOrigin } from "../server/request-boundary"
import { createSummarizerManager } from "../server/harnesses/manager"
import { createHarnessControl } from "../server/harnesses/control"
import { DEFAULT_DB_PATH, openDatabase } from "../server/db"
import { summarySupervisor } from "../server/summaries"
import { createBackup } from "../server/backup"
import { currentTailnetUrl, install, normalizeTailscaleService } from "./install"
import { runSetup, type SetupActions } from "./setup"
import { runSummariesCommand } from "./summaries"

const VERSION = packageJson.version

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
  setup hub [--name NAME] [--tailscale] [--service svc:NAME]
  setup join URL --pairing-file FILE
  serve [--db PATH] [--port PORT] [--api-only] [--static-dir PATH] [--trusted-origin ORIGIN ...]
  collect --once [--server URL] [--device-id ID] [--device-name NAME] [--state PATH]
  auth owner|rotate-owner|list|revoke|pair|read [--db PATH]
  summaries [status | use auto|omp|claude|codex|opencode|pi | off]
  configure collector --server URL [--name NAME] [--reset-device-id]
  backup --output PATH | --output-dir DIR [--retain 14] [--db PATH]
  install server|collector [--dry-run] [--tailscale] [--service svc:NAME]
  version`)
}

async function serve(args: string[]): Promise<void> {
  const host = valueAfter(args, "--host") ?? "127.0.0.1"
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host)) {
    throw new Error("trails serve only binds to a loopback host")
  }
  const port = parsePort(valueAfter(args, "--port") ?? process.env.TRAILS_PORT ?? "7412")
  const trustedOrigins = [...localOrigins(port), ...valuesAfter(args, "--trusted-origin").map(normalizeTrustedOrigin)]
  if (args.at(-1) === "--trusted-origin") throw new Error("--trusted-origin requires an HTTP(S) origin")
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
  const summarization = createSummarizerManager()
  const harnesses = createHarnessControl({ manager: summarization })
  const db = openDatabase(dbPath)
  initializeOwner(db)
  const app = createApp({ db, trustedOrigins, staticRoot, staticAssets, summarization, harnesses })
  const server = Bun.serve({ hostname: host, port, fetch: app })
  const summaryFiber = Effect.runFork(
    summarySupervisor({ db, summarizer: () => summarization.current(), status: summarization.status }),
  )
  const shutdown = () => {
    server.stop(true)
    Effect.runFork(Fiber.interrupt(summaryFiber))
    db.close()
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  console.log(terminalText(`trails serving on http://${host}:${server.port}`))
  console.log(terminalText(`Owner sign-in: trails auth owner (credential file: ${ownerTokenPath(db)})`))
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
  if (!config?.token) throw new Error("collector is not paired; use setup hub or setup join URL --pairing-file FILE")
  if (normalizeCollectorServer(server) !== config.server || deviceId !== config.deviceId) {
    throw new Error("collector credentials cannot be used with another hub or device ID")
  }
  const sourceRoots = valuesAfter(args, "--source-root")
  const result = await Effect.runPromise(
    runCollection({
      server,
      token: config.token,
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
    console.log(terminalText(`configured collector ${config.deviceName} (${config.deviceId}) for ${config.server}`))
    return
  }
  throw new Error("configure requires collector")
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
  console.log(terminalText(`wrote backup ${path}`))
}

async function installCommand(args: string[]): Promise<void> {
  if (args[0] !== "server" && args[0] !== "collector") throw new Error("install requires server or collector")
  const service = normalizeTailscaleService(valueAfter(args, "--service"))
  const tailscale = args.includes("--tailscale") || service !== undefined
  if (args[0] === "collector" && tailscale) {
    throw new Error("--tailscale and --service are available only for server installation")
  }
  await install({ kind: args[0], dryRun: args.includes("--dry-run"), tailscale, service })
}

async function waitForServer(server: string): Promise<void> {
  const endpoint = new URL("api/health", server)
  let lastFailure = "server did not respond"
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_000) })
      const body = response.status === 200 ? await response.json() as unknown : null
      if (
        typeof body === "object" &&
        body !== null &&
        "ok" in body &&
        body.ok === true
      ) return
      lastFailure = `health check returned HTTP ${response.status}`
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`Trails at ${server} is not ready: ${lastFailure}`)
}

async function setupCommand(args: string[]): Promise<void> {
  const mode = args[0]
  const name = valueAfter(args, "--name")
  const service = normalizeTailscaleService(valueAfter(args, "--service"))
  const tailscale = args.includes("--tailscale") || service !== undefined
  const actions: SetupActions = {
    configureCollector: (server, deviceName) => {
      let config
      if (mode === "join") {
        const pairingFile = valueAfter(args, "--pairing-file")
        if (!pairingFile) throw new Error("setup join requires --pairing-file from the hub owner")
        config = importCollectorPairing(pairingFile, server)
      } else {
        config = configureCollector({ server, name: deviceName })
        const database = openDatabase(process.env.TRAILS_DB_PATH ?? DEFAULT_DB_PATH)
        try {
          initializeOwner(database)
          const existing = config.token ? credentialFor(database, config.token) : null
          if (existing?.role !== "collector" || existing.deviceId !== config.deviceId) {
            const credential = issueCredential(database, "collector", config.deviceId)
            config = { ...config, token: credential.token }
            atomicWriteJson(COLLECTOR_CONFIG_PATH, config)
          }
        } finally { database.close() }
      }
      console.log(terminalText(`configured ${config.deviceName} for ${config.server}`))
    },
    install: (kind, options) => install({ kind, dryRun: false, ...options }),
    collect: () => collect(["--once"]),
    waitForServer,
    tailnetUrl: currentTailnetUrl,
    advertiseHub: (url) => {
      const database = openDatabase(process.env.TRAILS_DB_PATH ?? DEFAULT_DB_PATH)
      try {
        setAdvertisedHubUrl(database, normalizeCollectorServer(url))
      } finally {
        database.close()
      }
    },
  }
  if (mode === "hub") {
    const url = await runSetup({ mode, name, tailscale, service }, actions)
    console.log(terminalText(`Trails is ready at ${url}`))
    if (tailscale) console.log(terminalText(`Pair another Mac on this hub with: trails auth pair --server ${url} --output pairing.json`))
    else console.log("This Mac is both the hub and collector. Add --tailscale only when connecting other Macs.")
    return
  }
  if (mode === "join") {
    if (tailscale) throw new Error("--tailscale and --service are available only for hub setup")
    const server = args[1]
    if (!server || server.startsWith("--")) throw new Error("setup join requires the hub URL")
    const url = await runSetup({ mode, server: normalizeCollectorServer(server), name }, actions)
    console.log(terminalText(`Trails is collecting this Mac for ${url}`))
    return
  }
  throw new Error("setup requires hub or join")
}

async function dispatch(args: string[]): Promise<void> {
  const command = args[0]
  if (command === "auth") return runAuthCommand(args.slice(1))
  if (command === "setup") return setupCommand(args.slice(1))
  if (command === "serve") return serve(args.slice(1))
  if (command === "collect") return collect(args.slice(1))
  if (command === "configure") return configure(args.slice(1))
  if (command === "backup") return backup(args.slice(1))
  if (command === "install") return installCommand(args.slice(1))
  if (command === "summaries") return runSummariesCommand(args.slice(1))
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

// Both source and compiled entrypoints must use the same safe diagnostic boundary.
export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    await dispatch(args)
  } catch (error) {
    console.error(terminalText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
