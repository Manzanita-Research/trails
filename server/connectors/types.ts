import type { Effect } from "effect"
import type { ProviderId } from "../../shared/providers"

/** Closed enum; these tokens are the only provider-failure detail that may
 * reach SQLite job rows, logs, or browser responses. */
export type SummarizeErrorClass =
  | "auth_required"
  | "quota"
  | "provider_rejected"
  | "timeout"
  | "protocol"
  | "network"

export class SummarizeError extends Error {
  readonly errorClass: SummarizeErrorClass

  constructor(errorClass: SummarizeErrorClass) {
    super(errorClass)
    this.name = errorClass
    this.errorClass = errorClass
  }
}

export interface InferenceResult {
  readonly text: string
  readonly model: string
}

export interface Summarizer {
  readonly provider: ProviderId
  readonly model: string
  summarize(kind: "session" | "day", input: string): Effect.Effect<InferenceResult, SummarizeError>
}

/** Longest stored summary; anything the provider returns is trimmed and capped. */
export const MAX_SUMMARY_CHARS = 4_000

export const REQUEST_TIMEOUT_MS = 120_000

export function classForStatus(status: number): SummarizeErrorClass {
  if (status === 401 || status === 403) return "auth_required"
  if (status === 402 || status === 429) return "quota"
  if (status >= 400 && status < 500) return "provider_rejected"
  return "network"
}

export function toSummarizeError(cause: unknown): SummarizeError {
  if (cause instanceof SummarizeError) return cause
  if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return new SummarizeError("timeout")
  }
  return new SummarizeError("network")
}

export function boundedText(raw: unknown): string {
  if (typeof raw !== "string") throw new SummarizeError("protocol")
  const text = raw.trim().slice(0, MAX_SUMMARY_CHARS)
  if (!text) throw new SummarizeError("protocol")
  return text
}
