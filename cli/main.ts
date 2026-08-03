import { join, resolve } from "node:path"
import { createApp } from "../server/app"
import { DEFAULT_DB_PATH, openDatabase } from "../server/db"

const VERSION = "0.1.0"

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("port must be between 1 and 65535")
  return port
}

function printUsage(): void {
  console.log(`trails ${VERSION}\n\nCommands:\n  serve [--db PATH] [--port PORT] [--api-only] [--static-dir PATH]\n  version`)
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
  const standalone = "isStandaloneExecutable" in Bun && Bun.isStandaloneExecutable === true
  if (standalone && staticOverride) throw new Error("--static-dir is available only in source mode")
  const staticRoot = apiOnly
    ? undefined
    : staticOverride
      ? resolve(staticOverride)
      : standalone
        ? join(import.meta.dir, "dist/client")
        : resolve("dist/client")
  const db = openDatabase(dbPath)
  const app = createApp({ db, staticRoot })
  const server = Bun.serve({ hostname: host, port, fetch: app })
  const shutdown = () => {
    server.stop(true)
    db.close()
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  console.log(`trails serving on http://${host}:${server.port}`)
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0]
  if (command === "serve") return serve(args.slice(1))
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
