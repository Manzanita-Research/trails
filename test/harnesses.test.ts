import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { loadHubConfig } from "../cli/config"
import { HARNESS_IDS, type HarnessId } from "../shared/harnesses"
import { createHarnessControl } from "../server/harnesses/control"
import { createSummarizerManager } from "../server/harnesses/manager"
import {
  createHarnessResolver,
  createHarnessSummarizer,
  resolveHarness,
  runHarnessProcess,
  type HarnessProcessRequest,
  type HarnessProcessResult,
} from "../server/harnesses/runtime"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function processResult(overrides: Partial<HarnessProcessResult> = {}): HarnessProcessResult {
  return {
    exitCode: 0,
    stdout: "",
    stderr: "",
    output: null,
    timedOut: false,
    ...overrides,
  }
}

describe("harness discovery", () => {
  test("finds owner-installed executables and resolves auto in declared order", () => {
    const home = mkdtempSync(join(tmpdir(), "trails-harness-home-"))
    roots.push(home)
    const bin = join(home, ".local", "bin")
    mkdirSync(bin, { recursive: true })
    for (const command of ["claude", "omp"]) {
      const path = join(bin, command)
      writeFileSync(path, "#!/bin/sh\n", { mode: 0o700 })
      chmodSync(path, 0o700)
    }
    const resolver = createHarnessResolver({ home, path: "" })
    expect(resolver("claude")).toBe(realpathSync(join(bin, "claude")))
    expect(resolver("codex")).toBeNull()
    expect(resolveHarness("auto", resolver)?.id).toBe("omp")
    expect(resolveHarness("claude", resolver)?.id).toBe("claude")
  })
})

describe("harness invocation", () => {
  for (const id of HARNESS_IDS) {
    test(`${id} starts a real child in the private directory without project context`, async () => {
      const root = mkdtempSync(join(tmpdir(), "trails-harness-cwd-"))
      roots.push(root)
      const project = join(root, "project")
      const serverDirectory = join(project, "server")
      mkdirSync(serverDirectory, { recursive: true })
      const contextFiles = ["AGENTS.md", "CLAUDE.md", ".claude/settings.json", ".pi/settings.json", "opencode.json"]
      for (const name of contextFiles) {
        const path = join(project, name)
        mkdirSync(join(path, ".."), { recursive: true })
        writeFileSync(path, "PARENT_PROJECT_CONTEXT")
      }
      const executable = join(root, id)
      // Observe startup before any adapter-specific --cwd/--cd/--dir handling.
      // Simulate ancestor discovery without loading any real harness or model.
      writeFileSync(executable, `#!${process.execPath}
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
const args = process.argv.slice(2)
const consumed = []
for (let directory = process.cwd();;) {
  for (const name of ${JSON.stringify(contextFiles)}) {
    const path = join(directory, name)
    if (existsSync(path)) consumed.push(readFileSync(path, "utf8"))
  }
  const parent = dirname(directory)
  if (parent === directory) break
  directory = parent
}
const promptFile = args.find((arg) => arg.startsWith("@"))
const prompt = promptFile ? readFileSync(promptFile.slice(1), "utf8") : await Bun.stdin.text()
const text = JSON.stringify({
  cwd: process.cwd(), temporary: realpathSync(process.env.TMPDIR), consumed, prompt, args,
  environment: process.env,
})
switch (${JSON.stringify(id)}) {
  case "claude": console.log(JSON.stringify({ result: text })); break
  case "opencode": console.log(JSON.stringify({ part: { type: "text", text } })); break
  case "codex": writeFileSync(args[args.indexOf("--output-last-message") + 1], text); break
  default: console.log(text)
}
`, { mode: 0o700 })
      chmodSync(executable, 0o700)
      const privateDigest = "PRIVATE_DIGEST_CWD_REGRESSION"
      const driver = join(root, "driver.ts")
      writeFileSync(driver, `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
import { createHarnessSummarizer } from ${JSON.stringify(import.meta.resolve("../server/harnesses/runtime"))}
const summarizer = createHarnessSummarizer({ id: ${JSON.stringify(id)}, executable: ${JSON.stringify(executable)}, timeoutMs: 5000 })
console.log(JSON.stringify(await Effect.runPromise(summarizer.summarize("session", ${JSON.stringify(privateDigest)}))))
`)
      // A separate server process avoids changing cwd/environment in the test runner.
      const child = Bun.spawn([process.execPath, driver], {
        cwd: serverDirectory,
        env: { ...process.env, PRIVATE_PARENT_SECRET: "must-not-leak", OPENCODE_CONFIG_CONTENT: "parent-config" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ])
      expect(stderr).toBe("")
      expect(exitCode).toBe(0)
      const result = JSON.parse(stdout)
      expect(result.model).toBe(`harness:${id}`)
      const observed = JSON.parse(result.text)
      expect(observed.cwd).toBe(observed.temporary)
      expect(observed.cwd).not.toBe(realpathSync(serverDirectory))
      expect(observed.cwd).toContain("trails-summary-")
      expect(observed.consumed).toEqual([])
      expect(observed.prompt).toContain(privateDigest)
      expect(JSON.stringify(observed.args)).not.toContain(privateDigest)
      expect(JSON.stringify(observed.environment)).not.toContain(privateDigest)
      expect(observed.environment.PRIVATE_PARENT_SECRET).toBeUndefined()
      expect(observed.environment.OPENCODE_CONFIG_CONTENT).toBe(
        id === "opencode" ? '{"permission":{"*":"deny"}}' : undefined,
      )
      expect(existsSync(observed.cwd)).toBe(false)
    })
  }

  test("uses noninteractive, ephemeral contracts and returns only bounded final text", async () => {
    const privateDigest = "PRIVATE_DIGEST"
    for (const id of HARNESS_IDS) {
      let request: HarnessProcessRequest | null = null
      let delivered = ""
      const resultByHarness: Record<HarnessId, HarnessProcessResult> = {
        omp: processResult({ stdout: "omp summary\n" }),
        claude: processResult({ stdout: JSON.stringify({ type: "result", result: "claude summary" }) }),
        codex: processResult({ output: "codex summary\n" }),
        opencode: processResult({ stdout: `${JSON.stringify({ part: { type: "text", text: "opencode summary" } })}\n` }),
        pi: processResult({ stdout: "pi summary\n" }),
      }
      const summarizer = createHarnessSummarizer({
        id,
        executable: `/fake/${id}`,
        runner: async (next) => {
          request = next
          delivered = next.stdin ?? readFileSync(next.args.find((value) => value.startsWith("@"))!.slice(1), "utf8")
          return resultByHarness[id]
        },
      })
      const result = await Effect.runPromise(summarizer.summarize("session", privateDigest))
      expect(result).toEqual({ text: `${id} summary`, model: `harness:${id}` })
      expect(delivered).toContain(privateDigest)
      expect(request).not.toBeNull()
      expect(request!.args.join(" ")).not.toContain(privateDigest)
      expect(JSON.stringify(request!.env ?? {})).not.toContain(privateDigest)
      expect(request!.cwd).toContain("trails-summary-")
      if (id === "omp" || id === "pi") {
        expect(request!.args).toContain("--no-tools")
        expect(request!.args).toContain("--no-session")
      }
      if (id === "claude") {
        expect(request!.args).toContain("--safe-mode")
        expect(request!.args).toContain("--no-session-persistence")
        expect(request!.args).toContain("dontAsk")
      }
      if (id === "codex") {
        expect(request!.args).toContain("--ephemeral")
        expect(request!.args).toContain("--ignore-user-config")
        expect(request!.args).toContain("shell_tool")
        expect(request!.args).toContain("computer_use")
        expect(request!.args).toContain("mcp_servers={}")
        expect(request!.args).toContain('web_search="disabled"')
        expect(request!.args).toContain("never")
      }
      if (id === "opencode") {
        expect(request!.args).toContain("--pure")
        expect(request!.env?.OPENCODE_CONFIG_CONTENT).toBe('{"permission":{"*":"deny"}}')
      }
    }
  })

  test("constructs a minimal child environment at the real spawn boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-harness-env-"))
    roots.push(root)
    const executable = join(root, "print-env")
    writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "\${PRIVATE_PARENT_SECRET-unset}"
printf '%s\\n' "$HOME"
printf '%s\\n' "$PATH"
printf '%s\\n' "$TMPDIR"
printf '%s\\n' "\${OPENCODE_CONFIG_CONTENT-unset}"
`, { mode: 0o700 })
    chmodSync(executable, 0o700)
    const previous = process.env.PRIVATE_PARENT_SECRET
    process.env.PRIVATE_PARENT_SECRET = "must-not-leak"
    try {
      const result = await runHarnessProcess({
        executable,
        args: [],
        cwd: root,
        env: { OPENCODE_CONFIG_CONTENT: "owned-config" },
        stdin: null,
        outputPath: null,
        timeoutMs: 5_000,
      })
      const [secret, home, path, temporary, owned] = result.stdout.trim().split("\n")
      expect(secret).toBe("unset")
      expect(home).toBeTruthy()
      expect(path).toBe(
        [
          join(homedir(), ".local/bin"),
          join(homedir(), ".bun/bin"),
          join(homedir(), ".opencode/bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
        ].join(":"),
      )
      expect(temporary).toBe(root)
      expect(owned).toBe("owned-config")
    } finally {
      if (previous === undefined) delete process.env.PRIVATE_PARENT_SECRET
      else process.env.PRIVATE_PARENT_SECRET = previous
    }
  })

  test("maps harness stderr to closed retry classes without exposing it", async () => {
    const cases = [
      { stderr: "please login first", timedOut: false, expected: "auth_required" },
      { stderr: "rate limit exceeded", timedOut: false, expected: "quota" },
      { stderr: "private arbitrary failure", timedOut: false, expected: "harness_failed" },
      { stderr: "", timedOut: true, expected: "timeout" },
    ] as const
    for (const item of cases) {
      const summarizer = createHarnessSummarizer({
        id: "omp",
        executable: "/fake/omp",
        runner: async () => processResult({ exitCode: 1, stderr: item.stderr, timedOut: item.timedOut }),
      })
      const outcome = await Effect.runPromise(Effect.either(summarizer.summarize("session", "digest")))
      expect(outcome._tag).toBe("Left")
      if (outcome._tag === "Left") expect(outcome.left.errorClass).toBe(item.expected)
    }
  })
})

describe("harness selection", () => {
  test("persists V3 selection, reports runtime state, and disconnects cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "trails-harness-config-"))
    roots.push(root)
    const configPath = join(root, "server.json")
    const resolver = (id: HarnessId) => id === "codex" ? "/fake/codex" : null
    const manager = createSummarizerManager({ configPath, resolver })
    const control = createHarnessControl({ manager, configPath, resolver })

    expect(control.status().active).toBeNull()
    expect(() => control.activate({ harness: "omp" })).toThrow("harness is not available")
    control.activate({ harness: "auto" })
    expect(loadHubConfig(configPath)).toEqual({ summarizer: { harness: "auto" } })
    expect(control.status().active).toEqual({
      selection: "auto",
      harness: "codex",
      state: "never_ran",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastErrorClass: null,
    })
    expect(manager.current()?.harness).toBe("codex")

    control.disconnect()
    expect(loadHubConfig(configPath)).toEqual({ summarizer: null })
    expect(control.status().active).toBeNull()
  })
})
