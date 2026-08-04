import {
  FeedbackReceiptV1Schema,
  decodeExact,
  type FeedbackReceiptV1,
  type FeedbackSubmissionV1,
} from "../../shared/protocol"
export const FEEDBACK_ENDPOINT = "https://trails-beta-feedback.manzanita.workers.dev/api/feedback"


export type FeedbackView = NonNullable<FeedbackSubmissionV1["context"]>["view"]
export type FeedbackSafeContext = NonNullable<FeedbackSubmissionV1["context"]>

type FeedbackSource = keyof NonNullable<FeedbackSafeContext["sourceCounts"]>

export interface FeedbackSafeContextInput {
  readonly appVersion: string
  readonly view: FeedbackView
  readonly bootstrap: null | {
    readonly revision: number
    readonly sessions: ReadonlyArray<{ readonly source: FeedbackSource }>
  }
  readonly workDate: string | null
  readonly viewport: {
    readonly width: number
    readonly height: number
  }
  readonly syncError: boolean
}

export function buildFeedbackSafeContext(input: FeedbackSafeContextInput): FeedbackSafeContext {
  const bootstrap = input.bootstrap
  const sourceCounts =
    bootstrap === null
      ? null
      : {
          claude: 0,
          codex: 0,
          omp: 0,
          pi: 0,
        }

  if (bootstrap !== null && sourceCounts !== null) {
    for (const session of bootstrap.sessions) sourceCounts[session.source]++
  }

  return {
    appVersion: input.appVersion,
    view: input.view,
    revision: bootstrap?.revision ?? null,
    workDate: input.view === "days" || input.view === "project" ? input.workDate : null,
    sourceCounts,
    viewport: {
      width: Math.min(10_000, Math.max(1, Math.round(input.viewport.width))),
      height: Math.min(10_000, Math.max(1, Math.round(input.viewport.height))),
    },
    syncError: input.syncError,
  }
}

export class FeedbackSubmissionError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`feedback request failed (${status})`)
    this.name = "FeedbackSubmissionError"
    this.status = status
  }
}

export class FeedbackRateLimitError extends FeedbackSubmissionError {
  constructor() {
    super(429)
    this.name = "FeedbackRateLimitError"
  }
}

export async function submitFeedback(endpoint: string, serializedPayload: string): Promise<FeedbackReceiptV1> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: serializedPayload,
  })

  if (response.status === 429) throw new FeedbackRateLimitError()
  if (!response.ok) throw new FeedbackSubmissionError(response.status)
  return decodeExact(FeedbackReceiptV1Schema, await response.json())
}
