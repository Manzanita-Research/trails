import type { Effect } from "effect"
import type { HarnessId } from "../../shared/harnesses"

/** Closed enum; these tokens are the only harness-failure details stored or returned. */
export type SummarizeErrorClass =
  | "auth_required"
  | "quota"
  | "harness_failed"
  | "timeout"
  | "protocol"

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
  readonly harness: HarnessId
  summarize(kind: "session" | "day", input: string): Effect.Effect<InferenceResult, SummarizeError>
}

export const MAX_SUMMARY_CHARS = 4_000
export const REQUEST_TIMEOUT_MS = 120_000

export function boundedText(raw: unknown): string {
  if (typeof raw !== "string") throw new SummarizeError("protocol")
  const text = raw.trim().slice(0, MAX_SUMMARY_CHARS)
  if (!text) throw new SummarizeError("protocol")
  return text
}
