import { Effect } from "effect"
import { createReadStream } from "node:fs"
import { basename } from "node:path"
import readline from "node:readline"
import type { Source, UtcActivityTuple } from "../shared/domain"
import { decodeExact, IngestSessionV2Schema, type IngestSessionV2 } from "../shared/protocol"

export const MAX_USER_MSGS = 20
export const MAX_USER_LEN = 400
export const MAX_AGENT_LEN = 600
export const MAX_DIGEST = 9000

const TIMESTAMP_PATTERN = /"timestamp":"([^"]+)"/
const CWD_PATTERN = /"cwd":"([^"]+)"/
const BRANCH_PATTERN = /"gitBranch":"([^"]*)"/

type TextBlock = { readonly type?: string; readonly text?: string }
type TranscriptEntry = {
  readonly type?: unknown
  readonly timestamp?: unknown
  readonly cwd?: unknown
  readonly gitBranch?: unknown
  readonly parentSession?: unknown
  readonly payload?: { readonly message?: unknown }
  readonly message?: { readonly content?: unknown }
}

function cleanText(text: string, maximum: number): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum)
}

export function cleanSnippet(text: string): string {
  return cleanText(text, 240)
}

export function sourceSessionId(path: string, source: Source): string {
  const name = basename(path, ".jsonl")
  if (source === "claude") return name
  if (source === "codex") return name.replace(/^rollout-[0-9T-]+-/, "")
  return name.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/, "")
}

function messageText(entry: TranscriptEntry): string | null {
  const content = entry.message?.content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const textBlock = content.find(
    (block): block is TextBlock =>
      typeof block === "object" && block !== null && "type" in block && block.type === "text",
  )
  return typeof textBlock?.text === "string" ? textBlock.text : null
}

function isUsefulUserText(text: string): boolean {
  return !text.startsWith("Caveat:") && !text.includes("command-name")
}

export function parseSessionFile(path: string, source: Source): Effect.Effect<IngestSessionV2 | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      const buckets = new Map<number, [number, number, number]>()
      const userMessages: string[] = []
      const closingAgentMessages: string[] = []
      let cwd: string | null = null
      let branch: string | null = null
      let startMs: number | null = null
      let endMs: number | null = null
      let events = 0
      let userEvents = 0
      let totalUserMessages = 0
      let firstPrompt: string | null = null
      let cutoffMs: number | null = null
      let lineNumber = 0
      let excluded = false

      const input = createReadStream(path)
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      for await (const line of lines) {
        lineNumber++
        if (!line) continue
        if (source === "codex" && lineNumber === 1 && line.includes('"thread_source":"subagent"')) {
          excluded = true
          lines.close()
          input.destroy()
          break
        }

        let parsed: TranscriptEntry | null = null
        try {
          const value: unknown = JSON.parse(line)
          if (typeof value === "object" && value !== null) parsed = value as TranscriptEntry
        } catch {}

        if ((source === "omp" || source === "pi") && lineNumber <= 2 && parsed?.type === "session") {
          cwd ??= typeof parsed.cwd === "string" ? parsed.cwd : null
          if (parsed.parentSession && typeof parsed.timestamp === "string") {
            const candidate = new Date(parsed.timestamp).getTime()
            if (!Number.isNaN(candidate)) cutoffMs = candidate
          }
        }
        if (!cwd) cwd = typeof parsed?.cwd === "string" ? parsed.cwd : CWD_PATTERN.exec(line)?.[1] ?? null
        if (!branch) {
          const candidate = typeof parsed?.gitBranch === "string" ? parsed.gitBranch : BRANCH_PATTERN.exec(line)?.[1]
          if (candidate) branch = candidate
        }

        const timestamp = typeof parsed?.timestamp === "string" ? parsed.timestamp : TIMESTAMP_PATTERN.exec(line)?.[1]
        const timestampMs = timestamp ? new Date(timestamp).getTime() : Number.NaN
        const beforeCutoff = cutoffMs !== null && !Number.isNaN(timestampMs) && timestampMs < cutoffMs
        const isUser =
          source === "claude"
            ? line.includes('"type":"user"') && !line.includes('"toolUseResult"') && !line.includes('"isMeta":true')
            : source === "codex"
              ? line.includes('"user_message"')
              : line.includes('"type":"message"') && line.includes('"role":"user"')
        const isAssistant =
          source === "claude"
            ? line.includes('"type":"assistant"') && line.includes('"text"')
            : source === "codex"
              ? line.includes('"agent_message"')
              : line.includes('"type":"message"') && line.includes('"role":"assistant"') && line.includes('"text"')

        if (parsed && !beforeCutoff && isUser) {
          const text = source === "codex" ? parsed.payload?.message : messageText(parsed)
          if (typeof text === "string" && isUsefulUserText(text)) {
            totalUserMessages++
            const cleaned = cleanText(text, MAX_USER_LEN)
            if (!firstPrompt && lineNumber < 400 && cleaned.length > 2) firstPrompt = cleaned.slice(0, 240)
            if (userMessages.length < MAX_USER_MSGS) userMessages.push(cleaned)
          }
        } else if (parsed && !beforeCutoff && isAssistant) {
          const text = source === "codex" ? parsed.payload?.message : messageText(parsed)
          if (typeof text === "string") {
            closingAgentMessages.push(cleanText(text, MAX_AGENT_LEN))
            if (closingAgentMessages.length > 3) closingAgentMessages.shift()
          }
        }

        if (!timestamp || Number.isNaN(timestampMs) || beforeCutoff) continue
        const utcMinute = Math.floor(timestampMs / 60_000)
        events++
        if (isUser) userEvents++
        startMs = startMs === null ? timestampMs : Math.min(startMs, timestampMs)
        endMs = endMs === null ? timestampMs : Math.max(endMs, timestampMs)
        const bucket = buckets.get(utcMinute)
        if (bucket) {
          bucket[1]++
          if (isUser) bucket[2]++
        } else {
          buckets.set(utcMinute, [utcMinute, 1, isUser ? 1 : 0])
        }
      }

      if (excluded || startMs === null || endMs === null || events < 2) return null
      const activity = [...buckets.values()].sort((left, right) => left[0] - right[0]) as UtcActivityTuple[]
      const durationMinutes = Math.round((endMs - startMs) / 60_000)
      const digestParts = [
        `Project: ${cwd ?? "unknown"}${branch ? ` (branch ${branch})` : ""}`,
        `Duration: ~${durationMinutes} min, ${totalUserMessages} user messages, agent: ${source}`,
        userMessages.length
          ? `User messages (in order${totalUserMessages > userMessages.length ? `, first ${userMessages.length} of ${totalUserMessages}` : ""}):\n${userMessages.map((message) => `- ${message}`).join("\n")}`
          : "",
        closingAgentMessages.length
          ? `Agent's closing messages:\n${closingAgentMessages.map((message) => `- ${message}`).join("\n")}`
          : "",
      ]
      const digestText = digestParts.filter(Boolean).join("\n\n").slice(0, MAX_DIGEST) || null
      return decodeExact(IngestSessionV2Schema, {
        sourceSessionId: sourceSessionId(path, source),
        source,
        cwd,
        branch,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        events,
        userEvents,
        firstPrompt,
        activity,
        digest: digestText,
      })
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}
