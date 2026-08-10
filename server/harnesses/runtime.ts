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

export interface HarnessProcessRequest {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
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
    cwd: request.cwd,
    env: { ...globalThis.process.env, HOME: homedir() },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  if (request.stdin !== null) process.stdin.write(request.stdin)
  process.stdin.end()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill()
  }, request.timeoutMs)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      readLimited(process.stdout, MAX_PROCESS_OUTPUT_BYTES),
      readLimited(process.stderr, MAX_PROCESS_OUTPUT_BYTES),
    ])
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
    return { exitCode, stdout, stderr, output, timedOut }
  } finally {
    clearTimeout(timer)
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
          "exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--ignore-rules",
          "--cd", directory, "--output-last-message", outputPath, "-",
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
        try: async () => {
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
              stdin: invocation.stdin,
              outputPath: invocation.outputPath,
              timeoutMs,
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
