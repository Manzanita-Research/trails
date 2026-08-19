import { Effect } from "effect"
import { accessSync, constants, realpathSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { HARNESS_AUTO_ORDER, HARNESSES, type HarnessId } from "../../shared/harnesses"
import { DAY_SYSTEM, SESSION_SYSTEM } from "../../shared/prompts"
import {
  REQUEST_TIMEOUT_MS,
  SummarizeError,
  boundedText,
  type InferenceResult,
  type Summarizer,
  type SummarizeErrorClass,
} from "./types"

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024
const CODEX_ISOLATION_ARGS = [
  "--disable", "apps",
  "--disable", "browser_use",
  "--disable", "browser_use_external",
  "--disable", "browser_use_full_cdp_access",
  "--disable", "code_mode",
  "--disable", "code_mode_host",
  "--disable", "code_mode_only",
  "--disable", "computer_use",
  "--disable", "hooks",
  "--disable", "image_generation",
  "--disable", "memories",
  "--disable", "multi_agent",
  "--disable", "multi_agent_v2",
  "--disable", "plugins",
  "--disable", "shell_snapshot",
  "--disable", "shell_tool",
  "--disable", "skill_mcp_dependency_install",
  "--disable", "skill_search",
  "--disable", "tool_call_mcp_elicitation",
  "--disable", "unified_exec",
  "--disable", "workspace_dependencies",
  "--ask-for-approval", "never",
  "--config", 'mcp_servers={}',
  "--config", 'web_search="disabled"',
  "--config", "shell_environment_policy.inherit=none",
] as const
// mirrors the user-level directories the resolver searches: a harness found in
// ~/.local/bin or ~/.bun/bin may be a script whose interpreter lives there too
const HARNESS_PATH = [
  join(homedir(), ".local/bin"),
  join(homedir(), ".bun/bin"),
  join(homedir(), ".opencode/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(delimiter)

const OPENCODE_ISOLATION_CONFIG = JSON.stringify({ permission: { "*": "deny" } })


export interface HarnessProcessRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly signal?: AbortSignal
  readonly env?: Readonly<Record<string, string>>
  readonly stdin: string | null
  readonly outputPath: string | null
  readonly timeoutMs: number
}

export interface HarnessProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly output: string | null
  readonly timedOut: boolean
}

export type HarnessProcessRunner = (request: HarnessProcessRequest) => Promise<HarnessProcessResult>
export type HarnessResolver = (id: HarnessId) => string | null

async function readLimited(stream: ReadableStream<Uint8Array>, maximumBytes: number): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    length += result.value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new SummarizeError("protocol")
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export const runHarnessProcess: HarnessProcessRunner = async (request) => {
  const process = Bun.spawn([request.executable, ...request.args], {
    env: {
      HOME: homedir(),
      PATH: HARNESS_PATH,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: request.cwd,
      TMP: request.cwd,
      TEMP: request.cwd,
      ...request.env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (request.stdin !== null) process.stdin.write(request.stdin)
  process.stdin.end()
  let timedOut = false
  let termination: Promise<void> | null = null
  const terminate = (): Promise<void> => {
    if (termination !== null) return termination
    termination = (async () => {
      process.kill("SIGTERM")
      const exitedGracefully = await Promise.race([
        process.exited.then(() => true),
        Bun.sleep(1_000).then(() => false),
      ])
      if (!exitedGracefully) process.kill("SIGKILL")
      await process.exited
    })()
    return termination
  }
  const abort = () => { void terminate() }
  request.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    void terminate()
  }, request.timeoutMs)
  try {
    const [exitCode, stdoutResult, stderrResult] = await Promise.all([
      process.exited,
      readLimited(process.stdout, MAX_PROCESS_OUTPUT_BYTES).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: "", error }),
      ),
      readLimited(process.stderr, MAX_PROCESS_OUTPUT_BYTES).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: "", error }),
      ),
    ])
    if (stdoutResult.error !== null || stderrResult.error !== null) {
      throw stdoutResult.error ?? stderrResult.error
    }
    let output: string | null = null
    if (request.outputPath !== null) {
      try {
        const value = await readFile(request.outputPath, "utf8")
        if (Buffer.byteLength(value, "utf8") > MAX_PROCESS_OUTPUT_BYTES) throw new SummarizeError("protocol")
        output = value
      } catch (error) {
        if (exitCode === 0) throw error
      }
    }
    return { exitCode, stdout: stdoutResult.value, stderr: stderrResult.value, output, timedOut }
  } catch (error) {
    await terminate()
    throw error
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener("abort", abort)
  }
}

function executableDirectories(home: string, path: string | undefined): string[] {
  return [...new Set([
    join(home, ".local/bin"),
    join(home, ".bun/bin"),
    join(home, ".opencode/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    ...(path ?? "").split(delimiter).filter(Boolean),
  ])]
}

export function createHarnessResolver(options: {
  readonly home?: string
  readonly path?: string
} = {}): HarnessResolver {
  const home = options.home ?? homedir()
  const directories = executableDirectories(home, options.path ?? globalThis.process.env.PATH)
  return (id) => {
    const command = HARNESSES[id].command
    for (const directory of directories) {
      const candidate = join(directory, command)
      try {
        accessSync(candidate, constants.X_OK)
        return realpathSync(candidate)
      } catch {}
    }
    return null
  }
}

export function resolveHarness(
  selection: HarnessId | "auto",
  resolver: HarnessResolver,
): { readonly id: HarnessId; readonly executable: string } | null {
  const ids = selection === "auto" ? HARNESS_AUTO_ORDER : [selection]
  for (const id of ids) {
    const executable = resolver(id)
    if (executable !== null) return { id, executable }
  }
  return null
}

interface Invocation {
  readonly args: string[]
  readonly stdin: string | null
  readonly env?: Readonly<Record<string, string>>
  readonly outputPath: string | null
  readonly parse: (result: HarnessProcessResult) => string
}

function parseClaude(stdout: string): string {
  try {
    const value: unknown = JSON.parse(stdout)
    if (typeof value === "object" && value !== null && "result" in value) return boundedText(value.result)
  } catch {}
  throw new SummarizeError("protocol")
}

function parseOpenCode(stdout: string): string {
  let text: string | null = null
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    try {
      const event: unknown = JSON.parse(line)
      if (
        typeof event === "object" && event !== null && "part" in event &&
        typeof event.part === "object" && event.part !== null &&
        "type" in event.part && event.part.type === "text" &&
        "text" in event.part && typeof event.part.text === "string"
      ) text = event.part.text
    } catch {}
  }
  return boundedText(text)
}

function invocationOf(
  id: HarnessId,
  directory: string,
  promptPath: string,
  outputPath: string,
  systemPrompt: string,
  input: string,
): Invocation {
  switch (id) {
    case "omp":
      return {
        args: [
          "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
          "--no-rules", "--no-title", "--cwd", directory, "--system-prompt", systemPrompt, `@${promptPath}`,
        ],
        stdin: null,
        outputPath: null,
        parse: (result) => boundedText(result.stdout),
      }
    case "claude":
      return {
        args: [
          "--print", "--output-format", "json", "--no-session-persistence", "--safe-mode", "--tools", "",
          "--permission-mode", "dontAsk", "--system-prompt", systemPrompt,
        ],
        stdin: input,
        outputPath: null,
        parse: (result) => parseClaude(result.stdout),
      }
    case "codex":
      return {
        args: [
          ...CODEX_ISOLATION_ARGS,
          "exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only",
          "--skip-git-repo-check", "--ignore-rules", "--cd", directory, "--output-last-message", outputPath, "-",
        ],
        stdin: `${systemPrompt}\n\n${input}`,
        outputPath,
        parse: (result) => boundedText(result.output),
      }
    case "opencode":
      return {
        args: ["run", "--format", "json", "--pure", "--agent", "plan", "--dir", directory],
        stdin: `${systemPrompt}\n\n${input}`,
        outputPath: null,
        env: { OPENCODE_CONFIG_CONTENT: OPENCODE_ISOLATION_CONFIG },
        parse: (result) => parseOpenCode(result.stdout),
      }
    case "pi":
      return {
        args: [
          "-p", "--mode", "text", "--no-session", "--no-tools", "--no-extensions", "--no-skills",
          "--no-prompt-templates", "--no-context-files", "--system-prompt", systemPrompt, `@${promptPath}`,
        ],
        stdin: null,
        outputPath: null,
        parse: (result) => boundedText(result.stdout),
      }
  }
}

function errorClassOf(result: HarnessProcessResult): SummarizeErrorClass {
  if (result.timedOut) return "timeout"
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (/quota|rate.?limit|usage.?limit|credit|billing|too many requests/.test(message)) return "quota"
  if (/not logged in|login|log in|authentication|unauthorized|api.?key|oauth|sign in/.test(message)) {
    return "auth_required"
  }
  return "harness_failed"
}

export function createHarnessSummarizer(options: {
  readonly id: HarnessId
  readonly executable: string
  readonly runner?: HarnessProcessRunner
  readonly timeoutMs?: number
}): Summarizer {
  const runner = options.runner ?? runHarnessProcess
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  return {
    harness: options.id,
    summarize(kind, input): Effect.Effect<InferenceResult, SummarizeError> {
      return Effect.tryPromise({
        try: async (signal) => {
          const directory = await mkdtemp(join(tmpdir(), "trails-summary-"))
          const promptPath = join(directory, "input.txt")
          const outputPath = join(directory, "output.txt")
          try {
            await writeFile(promptPath, input, { mode: 0o600 })
            const invocation = invocationOf(
              options.id,
              directory,
              promptPath,
              outputPath,
              kind === "session" ? SESSION_SYSTEM : DAY_SYSTEM,
              input,
            )
            const result = await runner({
              executable: options.executable,
              args: invocation.args,
              cwd: directory,
              env: invocation.env,
              stdin: invocation.stdin,
              outputPath: invocation.outputPath,
              timeoutMs,
              signal,
            })
            if (result.exitCode !== 0 || result.timedOut) throw new SummarizeError(errorClassOf(result))
            return { text: invocation.parse(result), model: `harness:${options.id}` }
          } finally {
            await rm(directory, { recursive: true, force: true })
          }
        },
        catch: (cause) => cause instanceof SummarizeError ? cause : new SummarizeError("harness_failed"),
      })
    },
  }
}
