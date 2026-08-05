import { Effect, Schema } from "effect"
import { systemPrompt } from "../../shared/prompts"
import type { ProviderId } from "../../shared/providers"
import { getCredential } from "../../cli/auth"
import {
  boundedText,
  classForStatus,
  REQUEST_TIMEOUT_MS,
  SummarizeError,
  toSummarizeError,
  type InferenceResult,
  type Summarizer,
} from "./types"

export interface ChatCompletionsOptions {
  readonly provider: ProviderId
  readonly model: string
  readonly url: string
  /** Extra non-credential headers (attribution etc.). */
  readonly headers?: Readonly<Record<string, string>>
  readonly authPath?: string
  readonly fetcher?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

const CompletionSchema = Schema.Struct({
  model: Schema.optional(Schema.String),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.String) })),
      }),
    ),
  ),
})

/**
 * OpenAI-style chat-completions summarizer used by the OpenRouter and OpenAI
 * API-key providers. The API key is re-read from the credential store on every
 * call so logins/logouts apply without rebuilding the client.
 */
export function chatCompletionsSummarizer(options: ChatCompletionsOptions): Summarizer {
  const fetcher = options.fetcher ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  return {
    provider: options.provider,
    model: options.model,
    summarize: (kind, input) =>
      Effect.tryPromise({
        try: async (): Promise<InferenceResult> => {
          const credential = getCredential(options.provider, options.authPath)
          if (credential?.type !== "api") throw new SummarizeError("auth_required")
          const response = await fetcher(options.url, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            headers: {
              Authorization: `Bearer ${credential.key}`,
              "Content-Type": "application/json",
              ...options.headers,
            },
            body: JSON.stringify({
              model: options.model,
              max_tokens: 4096,
              messages: [
                { role: "system", content: systemPrompt(kind) },
                { role: "user", content: input },
              ],
            }),
          })
          if (!response.ok) throw new SummarizeError(classForStatus(response.status))
          let body: (typeof CompletionSchema)["Type"]
          try {
            body = Schema.decodeUnknownSync(CompletionSchema)(await response.json())
          } catch {
            throw new SummarizeError("protocol")
          }
          return {
            text: boundedText(body.choices?.[0]?.message?.content),
            model: body.model ? body.model.slice(0, 200) : options.model,
          }
        },
        catch: toSummarizeError,
      }),
  }
}
