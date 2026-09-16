import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = mkdtempSync(join(tmpdir(), "trails-install-exposure-"))
const executable = join(root, "installer")

beforeAll(async () => {
  const entry = join(root, "entry.ts")
  writeFileSync(entry, `import { install } from ${JSON.stringify(resolve("cli/install.ts"))}
    await install({ kind: "server", dryRun: process.argv.includes("--dry-run"), tailscale: process.argv.includes("--tailscale"), service: process.argv.find(a => a.startsWith("--service="))?.slice(10) })`)
  const result = await Bun.build({ entrypoints: [entry], compile: { outfile: executable }, minify: true })
  if (!result.success) throw new Error(result.logs.join("\n"))
}, 30_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

function fixture() {
  const home = mkdtempSync(join(root, "home-"))
  const bin = join(home, "bin")
  mkdirSync(bin)
  const configPath = join(home, "serve.json")
  const callsPath = join(home, "calls.jsonl")
  const statePath = join(home, ".local/state/trails/exposure.json")
  writeFileSync(configPath, "{}")
  writeFileSync(join(bin, "launchctl"), "#!/bin/sh\nexit 0\n")
  chmodSync(join(bin, "launchctl"), 0o700)
  writeFileSync(join(bin, "tailscale"), `#!${process.execPath}
    import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs"
    const args = process.argv.slice(2)
    const configPath = ${JSON.stringify(configPath)}
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n")
    if (args[0] === "status") { console.log(JSON.stringify({ Self: { DNSName: "hub.example.ts.net." } })); process.exit(0) }
    if (args[1] === "status") { console.log(JSON.stringify(config)); process.exit(0) }
    if (existsSync(${JSON.stringify(join(home, "fail"))})) process.exit(1)
    const service = args.find(a => a.startsWith("--service="))?.slice(10)
    const scope = service ? ((config.Services ??= {})[service] ??= {}) : config
    const hp = (service ? service.slice(4) : "hub") + ".example.ts.net:443"
    if (args.at(-1) === "off") {
      if (!args.includes("--set-path=/")) throw new Error("unscoped removal")
      delete scope.Web[hp].Handlers["/"]
    } else {
      scope.TCP ??= {}; scope.TCP["443"] = { HTTPS: true }
      scope.Web ??= {}; scope.Web[hp] ??= { Handlers: {} }
      scope.Web[hp].Handlers["/"] = { Proxy: args.at(-1) }
    }
    writeFileSync(configPath, JSON.stringify(config))
  `)
  chmodSync(join(bin, "tailscale"), 0o700)
  return {
    home, statePath, configPath, callsPath,
    run: (...args: string[]) => {
      const result = Bun.spawnSync([executable, ...args], {
        env: { HOME: home, PATH: bin, TMPDIR: root }, stdout: "pipe", stderr: "pipe",
      })
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
  }
}

describe("compiled installer exposure reporting and persistence", () => {
  test("persists verified local, node, named-service and local transitions", () => {
    const f = fixture()
    for (const [args, state] of [
      [[], { version: 1, mode: "local" }],
      [["--tailscale"], { version: 1, mode: "tailscale" }],
      [["--service=svc:trails"], { version: 1, mode: "tailscale", service: "svc:trails" }],
      [[], { version: 1, mode: "local" }],
    ] as const) {
      const result = f.run(...args)
      expect(result.code).toBe(0)
      expect(f.state()).toEqual(state)
      expect(statSync(f.statePath).mode & 0o777).toBe(0o600)
      expect(result.stdout.includes("Access: local only")).toBe(state.mode === "local")
    }
  })

  test("dry-run plans removal without changing mappings, files, or claiming local-only", () => {
    const f = fixture()
    expect(f.run("--tailscale").code).toBe(0)
    const before = readFileSync(f.configPath, "utf8")
    const state = readFileSync(f.statePath, "utf8")
    const result = f.run("--dry-run")
    expect(result.code).toBe(0)
    expect(result.stdout).toContain("remove 1 Trails route")
    expect(result.stdout).not.toContain("Access: local only")
    expect(readFileSync(f.configPath, "utf8")).toBe(before)
    expect(readFileSync(f.statePath, "utf8")).toBe(state)
  })

  test("failed removal exits unsuccessfully and preserves the previous exposure record", () => {
    const f = fixture()
    expect(f.run("--service=svc:trails").code).toBe(0)
    const state = readFileSync(f.statePath, "utf8")
    writeFileSync(join(f.home, "fail"), "")
    const result = f.run()
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("failed to remove")
    expect(result.stdout).not.toContain("Access: local only")
    expect(readFileSync(f.statePath, "utf8")).toBe(state)
  })

  test("rejects invalid saved state before installing or invoking Tailscale", () => {
    const f = fixture()
    mkdirSync(join(f.home, ".local/state/trails"), { recursive: true })
    writeFileSync(f.statePath, JSON.stringify({ version: 1, mode: "unexpected" }))
    expect(f.run().code).not.toBe(0)
    expect(existsSync(f.callsPath)).toBe(false)
    expect(existsSync(join(f.home, ".local/bin/trails"))).toBe(false)
  })
})
