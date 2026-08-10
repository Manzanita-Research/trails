import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadHubConfig } from "../cli/config"
import { HARNESS_IDS, type HarnessId } from "../shared/harnesses"
import { createHarnessControl } from "../server/harnesses/control"
import { createSummarizerManager } from "../server/harnesses/manager"
import {
  createHarnessResolver,
  createHarnessSummarizer,
  resolveHarness,
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
