import {
  FeedbackReceiptV1Schema,
  FeedbackSubmissionV1Schema,
  decodeExact,
  encodeExact,
  type FeedbackReceiptV1,
  type FeedbackSubmissionV1,
} from "../shared/protocol"

export interface RateLimitBinding {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>
}

export interface Env {
  readonly FEEDBACK_DB: D1Database
  readonly FEEDBACK_RATE_LIMITER: RateLimitBinding
}

interface StoredFeedback {
  readonly id: string
  readonly kind: FeedbackSubmissionV1["kind"]
  readonly message: string
  readonly follow_up: string | null
  readonly context_json: string | null
  readonly client_created_at: string
}

export const FEEDBACK_EXPIRY_MS = 7_776_000_000
const MAX_BODY_BYTES = 8 * 1024
const BODY_READ_TIMEOUT_MS = 5_000
const FEEDBACK_PATH = "/api/feedback"
const ALLOW = "POST, OPTIONS"

function allowedOrigin(value: string | null): string | null {
  if (value === null) return null
  if (
    value === "http://127.0.0.1:7412" ||
    value === "http://localhost:7412" ||
    value === "http://[::1]:7412"
  ) {
    return value
  }

  try {
    const parsed = new URL(value)
    if (parsed.origin !== value) return null
    return parsed.protocol === "https:" && parsed.hostname.endsWith(".ts.net") ? value : null
  } catch {
    return null
  }
}

function responseHeaders(origin: string | null, extra?: HeadersInit): Headers {
  const headers = new Headers(extra)
  if (origin !== null) {
    headers.set("Access-Control-Allow-Origin", origin)
    headers.set("Vary", "Origin")
  }
  return headers
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  extra?: HeadersInit,
): Response {
  const headers = responseHeaders(origin, extra)
  headers.set("Content-Type", "application/json; charset=utf-8")
  return new Response(JSON.stringify(body), { status, headers })
}

function errorResponse(error: string, status: number, origin: string | null, extra?: HeadersInit): Response {
  return jsonResponse({ error }, status, origin, extra)
}

async function readSubmissionBody(request: Request): Promise<Uint8Array | "oversize" | "timeout" | null> {
  const declaredLength = request.headers.get("Content-Length")
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      void request.body?.cancel().catch(() => {})
      return null
    }
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      void request.body?.cancel().catch(() => {})
      return "oversize"
    }
  }
  if (request.body === null) return null

  const reader = request.body.getReader()
  let complete = false
  let timer: ReturnType<typeof setTimeout> | undefined
  // One fixed buffer also bounds overhead for uploads delivered in tiny chunks.
  const bytes = new Uint8Array(MAX_BODY_BYTES)
  const read = async (): Promise<Uint8Array | "oversize"> => {
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        complete = true
        return bytes.subarray(0, length)
      }
      if (value.byteLength > MAX_BODY_BYTES - length) return "oversize"
      bytes.set(value, length)
      length += value.byteLength
    }
  }

  try {
    // Race the entire read, not individual chunks: progress must not reset the deadline.
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), BODY_READ_TIMEOUT_MS)
    })
    return await Promise.race([read(), timeout])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    // Do not let a stalled or failing source's cancellation delay the response.
    if (!complete) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function decodeSubmission(request: Request): Promise<FeedbackSubmissionV1 | "oversize" | "timeout" | null> {
  const bytes = await readSubmissionBody(request)
  if (bytes === null || typeof bytes === "string") return bytes

  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }

  try {
    return decodeExact(FeedbackSubmissionV1Schema, JSON.parse(text))
  } catch {
    return null
  }
}

function canonicalContextJson(context: FeedbackSubmissionV1["context"]): string | null {
  if (context === null) return null
  return JSON.stringify({
    appVersion: context.appVersion,
    view: context.view,
    revision: context.revision,
    workDate: context.workDate,
    sourceCounts:
      context.sourceCounts === null
        ? null
        : {
            claude: context.sourceCounts.claude,
            codex: context.sourceCounts.codex,
            omp: context.sourceCounts.omp,
            pi: context.sourceCounts.pi,
          },
    viewport: {
      width: context.viewport.width,
      height: context.viewport.height,
    },
    syncError: context.syncError,
  })
}

function sameSubmission(row: StoredFeedback, submission: FeedbackSubmissionV1, contextJson: string | null): boolean {
  return (
    row.kind === submission.kind &&
    row.message === submission.message &&
    row.follow_up === submission.followUp &&
    row.context_json === contextJson &&
    row.client_created_at === submission.createdAt
  )
}

async function findFeedback(db: D1Database, id: string): Promise<StoredFeedback | null> {
  return db
    .prepare(
      `SELECT id, kind, message, follow_up, context_json, client_created_at
       FROM feedback
       WHERE id = ?1`,
    )
    .bind(id)
    .first<StoredFeedback>()
}

function receiptFor(id: string): FeedbackReceiptV1 {
  return decodeExact(FeedbackReceiptV1Schema, {
    protocolVersion: 1,
    id,
    status: "received",
  })
}

async function persistFeedback(
  env: Env,
  submission: FeedbackSubmissionV1,
): Promise<{ readonly receipt: FeedbackReceiptV1; readonly created: boolean } | "conflict" | "unavailable"> {
  const contextJson = canonicalContextJson(submission.context)

  try {
    const existing = await findFeedback(env.FEEDBACK_DB, submission.id)
    if (existing !== null) {
      return sameSubmission(existing, submission, contextJson)
        ? { receipt: receiptFor(submission.id), created: false }
        : "conflict"
    }

    const receivedAt = Date.now()
    const insert = await env.FEEDBACK_DB
      .prepare(
        `INSERT OR IGNORE INTO feedback
          (id, kind, message, follow_up, context_json, client_created_at, received_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(
        submission.id,
        submission.kind,
        submission.message,
        submission.followUp,
        contextJson,
        submission.createdAt,
        receivedAt,
        receivedAt + FEEDBACK_EXPIRY_MS,
      )
      .run()

    if (insert.meta.changes === 1) {
      return { receipt: receiptFor(submission.id), created: true }
    }

    const raced = await findFeedback(env.FEEDBACK_DB, submission.id)
    if (raced === null) return "unavailable"
    return sameSubmission(raced, submission, contextJson)
      ? { receipt: receiptFor(submission.id), created: false }
      : "conflict"
  } catch {
    return "unavailable"
  }
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request.headers.get("Origin"))
    const url = new URL(request.url)

    if (url.pathname !== FEEDBACK_PATH) {
      return errorResponse("not found", 404, origin)
    }
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return errorResponse("method not allowed", 405, origin, { Allow: ALLOW })
    }
    if (origin === null) {
      return errorResponse("forbidden", 403, null)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: responseHeaders(origin, {
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
        }),
      })
    }

    let rateLimit
    try {
      rateLimit = await env.FEEDBACK_RATE_LIMITER.limit({
        key: request.headers.get("CF-Connecting-IP") ?? "",
      })
    } catch {
      return errorResponse("service unavailable", 503, origin)
    }
    if (!rateLimit.success) {
      return errorResponse("rate limited", 429, origin, { "Retry-After": "60" })
    }

    const contentType = request.headers.get("Content-Type")
    if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return errorResponse("content type must be application/json", 415, origin)
    }

    const submission = await decodeSubmission(request)
    if (submission === "oversize") {
      return errorResponse("request too large", 413, origin)
    }
    if (submission === "timeout") {
      return errorResponse("request timed out", 408, origin)
    }
    if (submission === null) {
      return errorResponse("invalid request", 400, origin)
    }

    const stored = await persistFeedback(env, submission)
    if (stored === "conflict") {
      return errorResponse("feedback id conflicts with an existing submission", 409, origin)
    }
    if (stored === "unavailable") {
      return errorResponse("service unavailable", 503, origin)
    }

    return jsonResponse(
      encodeExact(FeedbackReceiptV1Schema, stored.receipt),
      stored.created ? 201 : 200,
      origin,
    )
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await env.FEEDBACK_DB
      .prepare("DELETE FROM feedback WHERE expires_at <= ?1")
      .bind(controller.scheduledTime)
      .run()
  },
}

export default worker
