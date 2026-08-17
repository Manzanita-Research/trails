import { fixtureResponse } from "./fixture"

function fixturePort(args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): number {
  const flag = args.indexOf("--port")
  const raw = flag >= 0 ? args[flag + 1] : env.TRAILS_FIXTURE_PORT ?? "7414"
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("fixture port must be an integer from 0 to 65535")
  }
  return port
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: fixturePort(process.argv.slice(2), process.env),
  fetch: fixtureResponse,
})

const stop = () => server.stop(true)
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
console.log(`Trails fixture serving on http://127.0.0.1:${server.port}/`)
