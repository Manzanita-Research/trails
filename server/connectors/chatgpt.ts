import { Effect } from "effect"
import { getCredential, modifyCredentials, type OauthCredential } from "../../cli/auth"
import { systemPrompt } from "../../shared/prompts"
import {
  CHATGPT_EXPIRY_MARGIN_MS,
  CHATGPT_RESPONSES_URL,
  refreshChatgptGrant,
  type TokenGrant,
} from "./chatgpt-oauth"
import {
  boundedText,
  classForStatus,
  REQUEST_TIMEOUT_MS,
  SummarizeError,
  toSummarizeError,
  type InferenceResult,
  type Summarizer,
} from "./types"

export interface ChatgptOptions {
  readonly model: string
  readonly authPath?: string
  readonly fetcher?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

function storedCredential(authPath: string | undefined): OauthCredential {
  const credential = getCredential("chatgpt", authPath)
  if (credential?.type !== "oauth") throw new SummarizeError("auth_required")
  return credential
}

/**
 * Refresh and persist a rotated grant. Commits under the store lock; if a
 * concurrent process already rotated to a newer grant, theirs wins. When our
 * exchange fails but a peer refreshed meanwhile (single-use refresh tokens),
 * the peer's fresh credential is used instead of failing.
 */
async function refreshAndStore(
  current: OauthCredential,
  authPath: string | undefined,
  fetcher: typeof globalThis.fetch,
): Promise<OauthCredential> {
  let grant: TokenGrant
  try {
    grant = await refreshChatgptGrant(current, fetcher)
  } catch (error) {
    const latest = getCredential("chatgpt", authPath)
    if (
      latest?.type === "oauth" &&
      latest.refresh !== current.refresh &&
      latest.expires - CHATGPT_EXPIRY_MARGIN_MS > Date.now()
    ) {
      return latest
    }
    throw error
  }
  const refreshed: OauthCredential = { type: "oauth", ...grant }
  let stored = refreshed
  modifyCredentials((providers) => {
    const existing = providers["chatgpt"]
    if (existing?.type === "oauth" && existing.refresh !== current.refresh && existing.expires > refreshed.expires) {
      stored = existing
      return
    }
    providers["chatgpt"] = refreshed
  }, authPath)
  return stored
}

interface SseOutcome {
  readonly text: string
  readonly model: string
}

function extractCompletedText(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("output" in response)) return null
  const { output } = response
  if (!Array.isArray(output)) return null
  const parts: string[] = []
  for (const item of output as unknown[]) {
    if (typeof item !== "object" || item === null || !("type" in item) || item.type !== "message") continue
    if (!("content" in item) || !Array.isArray(item.content)) continue
    for (const piece of item.content as unknown[]) {
      if (typeof piece !== "object" || piece === null || !("type" in piece) || piece.type !== "output_text") continue
      if ("text" in piece && typeof piece.text === "string") parts.push(piece.text)
    }
  }
  return parts.length > 0 ? parts.join("") : null
}

function completedModel(response: unknown): string | null {
  if (typeof response !== "object" || response === null || !("model" in response)) return null
  return typeof response.model === "string" && response.model ? response.model.slice(0, 200) : null
}

async function readSse(response: Response, fallbackModel: string): Promise<SseOutcome> {
  if (!response.body) throw new SummarizeError("protocol")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let deltas = ""
  let completedText: string | null = null
  let model = fallbackModel
  let completed = false
  try {
    while (!completed) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf("\n")
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trimEnd()
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf("\n")
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === "[DONE]") continue
        let event: unknown
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }
        if (typeof event !== "object" || event === null || !("type" in event)) continue
        if (event.type === "response.output_text.delta") {
          if ("delta" in event && typeof event.delta === "string") deltas += event.delta
        } else if (event.type === "response.completed") {
          const inner = "response" in event ? event.response : null
          completedText = extractCompletedText(inner)
          model = completedModel(inner) ?? model
          completed = true
          break
        } else if (event.type === "response.failed" || event.type === "error") {
          throw new SummarizeError("provider_rejected")
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const text = completedText ?? deltas
  if (!completed || !text.trim()) throw new SummarizeError("protocol")
  return { text, model }
}

/**
 * Summarizer backed by the user's own ChatGPT subscription login, speaking the
 * same Responses-shaped SSE contract the Codex CLI uses. Unofficial interface;
 * labeled as such everywhere it is surfaced.
 */
export function createChatgptSummarizer(options: ChatgptOptions): Summarizer {
  const fetcher = options.fetcher ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  let refreshing: Promise<OauthCredential> | null = null

  const fresh = async (force: boolean): Promise<OauthCredential> => {
    const current = storedCredential(options.authPath)
    if (!force && current.expires - CHATGPT_EXPIRY_MARGIN_MS > Date.now()) return current
    if (!refreshing) {
      refreshing = refreshAndStore(current, options.authPath, fetcher).finally(() => {
        refreshing = null
      })
    }
    return refreshing
  }

  const post = async (credential: OauthCredential, kind: "session" | "day", input: string): Promise<Response> => {
    if (!credential.accountId) throw new SummarizeError("auth_required")
    return fetcher(CHATGPT_RESPONSES_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${credential.access}`,
        "chatgpt-account-id": credential.accountId,
        originator: "trails",
        "OpenAI-Beta": "responses=experimental",
        "Content-Type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: options.model,
        instructions: systemPrompt(kind),
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: input }],
          },
        ],
        stream: true,
        store: false,
      }),
    })
  }

  return {
    provider: "chatgpt",
    model: options.model,
    summarize: (kind, input) =>
      Effect.tryPromise({
        try: async (): Promise<InferenceResult> => {
          let credential = await fresh(false)
          let response = await post(credential, kind, input)
          if (response.status === 401) {
            credential = await fresh(true)
            response = await post(credential, kind, input)
          }
          if (!response.ok) throw new SummarizeError(classForStatus(response.status))
          const outcome = await readSse(response, options.model)
          return { text: boundedText(outcome.text), model: outcome.model }
        },
        catch: toSummarizeError,
      }),
  }
}
