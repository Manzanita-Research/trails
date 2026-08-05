import { describe, expect, test } from "bun:test"
import {
  FEEDBACK_EXPIRY_MS,
  worker,
  type Env,
  type RateLimitBinding,
} from "../feedback-worker/index"
import type { FeedbackSubmissionV1 } from "../shared/protocol"

const ORIGIN = "http://127.0.0.1:7412"
const ID = "2f6d09aa-c10a-4c6b-945b-998a291909c2"

const BASE_SUBMISSION = {
  protocolVersion: 1,
  id: ID,
  kind: "confusing",
  message: "The boundary between these sessions was unclear.",
  followUp: "I can share a reproduction.",
  createdAt: "2026-08-04T12:34:56.789Z",
  context: {
    appVersion: "0.1.0-alpha.5",
    view: "days",
    revision: 7,
    workDate: "2026-08-04",
    sourceCounts: { claude: 1, codex: 2, omp: 3, pi: 4 },
    viewport: { width: 1440, height: 900 },
    syncError: false,
  },
} satisfies FeedbackSubmissionV1

type StoredRow = {
  id: string
  kind: string
  message: string
  follow_up: string | null
  context_json: string | null
  client_created_at: string
  received_at: number
  expires_at: number
}

type StatementCall = {
  readonly sql: string
  bindings: unknown[]
}

class FakeD1 {
  readonly rows = new Map<string, StoredRow>()
  readonly statements: StatementCall[] = []
  fail: "select" | "insert" | "delete" | null = null
  raceOnInsert: StoredRow | "vanish" | null = null

  readonly database = {
    prepare: (sql: string): D1PreparedStatement => {
      const call: StatementCall = { sql, bindings: [] }
      this.statements.push(call)
      const statement = {
        bind: (...bindings: unknown[]) => {
          call.bindings = bindings
          return statement
        },
        first: async <T>() => {
          if (this.fail === "select") throw new Error("private select failure detail")
          const id = String(call.bindings[0])
          return (this.rows.get(id) ?? null) as T | null
        },
        run: async () => {
          if (/^\s*INSERT OR IGNORE/i.test(sql)) {
            if (this.fail === "insert") throw new Error("private insert failure detail")
            const [id, kind, message, followUp, contextJson, createdAt, receivedAt, expiresAt] = call.bindings
            const key = String(id)
            if (!this.rows.has(key) && this.raceOnInsert !== null) {
              if (this.raceOnInsert !== "vanish") this.rows.set(key, this.raceOnInsert)
              return { meta: { changes: 0 } } as D1Result
            }
            if (this.rows.has(key)) return { meta: { changes: 0 } } as D1Result
            this.rows.set(key, {
              id: key,
              kind: String(kind),
              message: String(message),
              follow_up: followUp === null ? null : String(followUp),
              context_json: contextJson === null ? null : String(contextJson),
              client_created_at: String(createdAt),
              received_at: Number(receivedAt),
              expires_at: Number(expiresAt),
            })
            return { meta: { changes: 1 } } as D1Result
          }

          if (/^\s*DELETE FROM feedback/i.test(sql)) {
            if (this.fail === "delete") throw new Error("private delete failure detail")
            const cutoff = Number(call.bindings[0])
            let changes = 0
            for (const [id, row] of this.rows) {
              if (row.expires_at <= cutoff) {
                this.rows.delete(id)
                changes += 1
              }
            }
            return { meta: { changes } } as D1Result
          }

          throw new Error(`unexpected statement: ${sql}`)
        },
      }
      return statement as unknown as D1PreparedStatement
    },
  } as D1Database
}

class FakeRateLimiter implements RateLimitBinding {
  readonly keys: string[] = []
  success = true
  failure: Error | null = null

  async limit({ key }: { readonly key: string }): Promise<{ readonly success: boolean }> {
    this.keys.push(key)
    if (this.failure !== null) throw this.failure
    return { success: this.success }
  }
}

function fakeEnv(): { readonly env: Env; readonly d1: FakeD1; readonly limiter: FakeRateLimiter } {
  const d1 = new FakeD1()
  const limiter = new FakeRateLimiter()
  return { env: { FEEDBACK_DB: d1.database, FEEDBACK_RATE_LIMITER: limiter }, d1, limiter }
}

function feedbackRequest(
  body: BodyInit | null = JSON.stringify(BASE_SUBMISSION),
  options: {
    readonly method?: string
    readonly origin?: string | null
    readonly path?: string
    readonly contentType?: string | null
    readonly ip?: string | null
  } = {},
): Request {
  const method = options.method ?? "POST"
  const headers = new Headers()
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN)
  if (options.contentType !== null) headers.set("Content-Type", options.contentType ?? "application/json")
  if (options.ip !== null) headers.set("CF-Connecting-IP", options.ip ?? "203.0.113.17")
  return new Request(`https://feedback.example${options.path ?? "/api/feedback"}`, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  })
}

function expectCors(response: Response, origin = ORIGIN): void {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin)
  expect(response.headers.get("Vary")).toBe("Origin")
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>
}

function storedFrom(submission: FeedbackSubmissionV1, receivedAt = 1_000): StoredRow {
  return {
    id: submission.id,
    kind: submission.kind,
    message: submission.message,
    follow_up: submission.followUp,
    context_json: submission.context === null ? null : JSON.stringify(submission.context),
    client_created_at: submission.createdAt,
    received_at: receivedAt,
    expires_at: receivedAt + FEEDBACK_EXPIRY_MS,
  }
}

type MutableSubmission = { -readonly [Key in keyof FeedbackSubmissionV1]: FeedbackSubmissionV1[Key] }

function cloneSubmission(): MutableSubmission {
  return structuredClone(BASE_SUBMISSION) as MutableSubmission
}

describe("hosted feedback Worker boundary", () => {
  test("serves no path other than the exact feedback route and exposes no read route", async () => {
    const { env, d1, limiter } = fakeEnv()

    const wrongPath = await worker.fetch(feedbackRequest(null, { path: "/api/feedback/" }), env)
    expect(wrongPath.status).toBe(404)
    expectCors(wrongPath)

    const readAttempt = await worker.fetch(feedbackRequest(null, { method: "GET" }), env)
    expect(readAttempt.status).toBe(405)
    expect(readAttempt.headers.get("Allow")).toBe("POST, OPTIONS")
    expectCors(readAttempt)

    const missingOriginRead = await worker.fetch(
      feedbackRequest(null, { method: "GET", origin: null }),
      env,
    )
    expect(missingOriginRead.status).toBe(405)
    expect(d1.statements).toHaveLength(0)
    expect(limiter.keys).toHaveLength(0)
  })

  test("accepts only the three loopback origins and HTTPS ts.net hostnames", async () => {
    const allowed = [
      "http://127.0.0.1:7412",
      "http://localhost:7412",
      "http://[::1]:7412",
      "https://mini.example.ts.net",
      "https://trails.ts.net",
    ]
    for (const origin of allowed) {
      const { env } = fakeEnv()
      const response = await worker.fetch(feedbackRequest(null, { method: "OPTIONS", origin }), env)
      expect(response.status).toBe(204)
      expectCors(response, origin)
    }

    const disallowed = [
      null,
      "http://mini.example.ts.net",
      "https://ts.net",
      "https://not-ts.net",
      "https://trails.ts.net.evil.example",
      "http://127.0.0.1:7413",
      "http://localhost:7412/",
      "https://trails.ts.net/path",
    ]
    for (const origin of disallowed) {
      const { env, d1, limiter } = fakeEnv()
      const response = await worker.fetch(feedbackRequest("not json", { origin }), env)
      expect(response.status).toBe(403)
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull()
      expect(d1.statements).toHaveLength(0)
      expect(limiter.keys).toHaveLength(0)
    }
  })

  test("answers preflight without rate limiting or touching D1", async () => {
    const { env, d1, limiter } = fakeEnv()
    const response = await worker.fetch(feedbackRequest(null, { method: "OPTIONS" }), env)

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST")
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type")
    expectCors(response)
    expect(d1.statements).toHaveLength(0)
    expect(limiter.keys).toHaveLength(0)
  })

  test("checks route, method, and origin before rate limiting or reading a body", async () => {
    const wrongPath = fakeEnv()
    const wrongPathResponse = await worker.fetch(
      feedbackRequest("invalid", { path: "/elsewhere", origin: null }),
      wrongPath.env,
    )
    expect(wrongPathResponse.status).toBe(404)
    expect(wrongPath.limiter.keys).toHaveLength(0)

    const wrongMethod = fakeEnv()
    const wrongMethodResponse = await worker.fetch(
      feedbackRequest(null, { method: "PATCH", origin: null }),
      wrongMethod.env,
    )
    expect(wrongMethodResponse.status).toBe(405)
    expect(wrongMethod.limiter.keys).toHaveLength(0)

    const wrongOrigin = fakeEnv()
    const wrongOriginResponse = await worker.fetch(
      feedbackRequest("invalid", { origin: "https://evil.example" }),
      wrongOrigin.env,
    )
    expect(wrongOriginResponse.status).toBe(403)
    expect(wrongOrigin.limiter.keys).toHaveLength(0)
    expect(wrongOrigin.d1.statements).toHaveLength(0)
  })

  test("rate limits the connecting IP before content type or body parsing", async () => {
    const limited = fakeEnv()
    limited.limiter.success = false
    const response = await worker.fetch(
      feedbackRequest("not json", { contentType: "text/plain", ip: "198.51.100.9" }),
      limited.env,
    )

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("60")
    expectCors(response)
    expect(limited.limiter.keys).toEqual(["198.51.100.9"])
    expect(limited.d1.statements).toHaveLength(0)

    const failed = fakeEnv()
    failed.limiter.failure = new Error("provider detail must not escape")
    const failedResponse = await worker.fetch(feedbackRequest("not json"), failed.env)
    expect(failedResponse.status).toBe(503)
    expect(JSON.stringify(await responseJson(failedResponse))).not.toContain("provider detail")
    expectCors(failedResponse)
  })

  test("requires application/json while accepting case and parameters", async () => {
    for (const contentType of [null, "text/json", "application/problem+json", "text/plain"]) {
      const { env, limiter } = fakeEnv()
      const response = await worker.fetch(feedbackRequest(JSON.stringify(BASE_SUBMISSION), { contentType }), env)
      expect(response.status).toBe(415)
      expect(limiter.keys).toEqual(["203.0.113.17"])
      expectCors(response)
    }

    for (const contentType of ["application/json", "Application/JSON; Charset=UTF-8"]) {
      const { env } = fakeEnv()
      const response = await worker.fetch(feedbackRequest(JSON.stringify(BASE_SUBMISSION), { contentType }), env)
      expect(response.status).toBe(201)
      expectCors(response)
    }
  })

  test("measures the actual byte body, rejects invalid UTF-8, and permits exactly 8 KiB to reach JSON parsing", async () => {
    const oversized = fakeEnv()
    const oversizedResponse = await worker.fetch(feedbackRequest(new Uint8Array(8_193)), oversized.env)
    expect(oversizedResponse.status).toBe(413)
    expect(oversized.d1.statements).toHaveLength(0)
    expectCors(oversizedResponse)

    const exact = fakeEnv()
    const exactResponse = await worker.fetch(feedbackRequest(new Uint8Array(8_192).fill(0x7b)), exact.env)
    expect(exactResponse.status).toBe(400)
    expect(exact.d1.statements).toHaveLength(0)
    expectCors(exactResponse)

    const multibyte = fakeEnv()
    const text = JSON.stringify({ padding: "界".repeat(3_000) })
    expect(text.length).toBeLessThan(8_192)
    const multibyteResponse = await worker.fetch(feedbackRequest(text), multibyte.env)
    expect(multibyteResponse.status).toBe(413)

    const invalidUtf8 = fakeEnv()
    const invalidUtf8Response = await worker.fetch(
      feedbackRequest(new Uint8Array([0xc3, 0x28])),
      invalidUtf8.env,
    )
    expect(invalidUtf8Response.status).toBe(400)
    expect(invalidUtf8.d1.statements).toHaveLength(0)
  })

  test("rejects malformed JSON and every exact submission boundary", async () => {
    const malformed = fakeEnv()
    const malformedResponse = await worker.fetch(feedbackRequest("{"), malformed.env)
    expect(malformedResponse.status).toBe(400)
    expectCors(malformedResponse)

    const context = BASE_SUBMISSION.context
    const invalidBodies: ReadonlyArray<unknown> = [
      { ...BASE_SUBMISSION, unexpected: true },
      { ...BASE_SUBMISSION, protocolVersion: 2 },
      { ...BASE_SUBMISSION, id: "not-a-uuid" },
      { ...BASE_SUBMISSION, kind: "praise" },
      { ...BASE_SUBMISSION, message: "" },
      { ...BASE_SUBMISSION, message: " leading" },
      { ...BASE_SUBMISSION, message: "x".repeat(2_001) },
      { ...BASE_SUBMISSION, followUp: "" },
      { ...BASE_SUBMISSION, followUp: "trailing " },
      { ...BASE_SUBMISSION, followUp: "x".repeat(201) },
      { ...BASE_SUBMISSION, createdAt: "2026-08-04T12:34:56Z" },
      { ...BASE_SUBMISSION, context: { ...context, unexpected: true } },
      { ...BASE_SUBMISSION, context: { ...context, appVersion: " beta" } },
      { ...BASE_SUBMISSION, context: { ...context, appVersion: "x".repeat(41) } },
      { ...BASE_SUBMISSION, context: { ...context, revision: -1 } },
      { ...BASE_SUBMISSION, context: { ...context, revision: 1.5 } },
      { ...BASE_SUBMISSION, context: { ...context, workDate: "2026-02-30" } },
      {
        ...BASE_SUBMISSION,
        context: { ...context, sourceCounts: { ...context.sourceCounts, claude: -1 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, sourceCounts: { ...context.sourceCounts, codex: 1.5 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, sourceCounts: { ...context.sourceCounts, extra: 0 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, viewport: { ...context.viewport, width: 0 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, viewport: { ...context.viewport, width: 10_001 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, viewport: { ...context.viewport, height: 1.5 } },
      },
      {
        ...BASE_SUBMISSION,
        context: { ...context, viewport: { ...context.viewport, extra: 1 } },
      },
      { ...BASE_SUBMISSION, context: { ...context, syncError: "false" } },
    ]

    for (const body of invalidBodies) {
      const { env, d1 } = fakeEnv()
      const response = await worker.fetch(feedbackRequest(JSON.stringify(body)), env)
      expect(response.status).toBe(400)
      expect(d1.statements).toHaveLength(0)
      expectCors(response)
    }
  })

  test("accepts all kinds, views, nullable fields, and exact inclusive numeric bounds", async () => {
    const kinds = ["confusing", "broken", "idea", "delight"] as const
    const views = ["loading", "hub-error", "welcome", "days", "week", "threads", "project", "settings"] as const

    for (const [index, view] of views.entries()) {
      const submission = cloneSubmission()
      submission.id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`
      submission.kind = kinds[index % kinds.length]!
      submission.message = "x"
      submission.followUp = null
      submission.context = {
        appVersion: index === views.length - 1 ? "v".repeat(40) : "v",
        view,
        revision: index === 0 ? null : 0,
        workDate: null,
        sourceCounts: index === 0 ? null : { claude: 0, codex: 0, omp: 0, pi: 0 },
        viewport: { width: 1, height: 10_000 },
        syncError: index % 2 === 0,
      }
      const { env } = fakeEnv()
      const response = await worker.fetch(feedbackRequest(JSON.stringify(submission)), env)
      expect(response.status).toBe(201)
    }

    const contextOff = cloneSubmission()
    contextOff.context = null
    contextOff.followUp = "x".repeat(200)
    contextOff.message = "x".repeat(2_000)
    const { env } = fakeEnv()
    expect((await worker.fetch(feedbackRequest(JSON.stringify(contextOff)), env)).status).toBe(201)
  })

  test("inserts parameterized content, returns the exact receipt, and sets exact retention from server time", async () => {
    const { env, d1, limiter } = fakeEnv()
    const before = Date.now()
    const response = await worker.fetch(feedbackRequest(), env)
    const after = Date.now()

    expect(response.status).toBe(201)
    expect(await responseJson(response)).toEqual({ protocolVersion: 1, id: ID, status: "received" })
    expectCors(response)
    expect(d1.rows.size).toBe(1)

    const row = d1.rows.get(ID)!
    expect(row.received_at).toBeGreaterThanOrEqual(before)
    expect(row.received_at).toBeLessThanOrEqual(after)
    expect(row.expires_at - row.received_at).toBe(FEEDBACK_EXPIRY_MS)
    expect(row.context_json).toBe(JSON.stringify(BASE_SUBMISSION.context))

    const insert = d1.statements.find((statement) => /^\s*INSERT OR IGNORE/i.test(statement.sql))!
    expect(insert.sql).toContain("VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    expect(insert.sql).not.toContain(ID)
    expect(insert.sql).not.toContain(BASE_SUBMISSION.message)
    expect(insert.bindings.slice(0, 6)).toEqual([
      ID,
      BASE_SUBMISSION.kind,
      BASE_SUBMISSION.message,
      BASE_SUBMISSION.followUp,
      JSON.stringify(BASE_SUBMISSION.context),
      BASE_SUBMISSION.createdAt,
    ])

    expect(limiter.keys).toEqual(["203.0.113.17"])
    expect(insert.bindings).not.toContain("203.0.113.17")
    expect(JSON.stringify([...d1.rows.values()])).not.toContain("203.0.113.17")
  })

  test("returns 200 for identical retries and 409 when a UUID changes content", async () => {
    const { env, d1 } = fakeEnv()
    const first = await worker.fetch(feedbackRequest(), env)
    expect(first.status).toBe(201)

    const retry = await worker.fetch(feedbackRequest(), env)
    expect(retry.status).toBe(200)
    expect(await responseJson(retry)).toEqual({ protocolVersion: 1, id: ID, status: "received" })
    expectCors(retry)
    expect(d1.rows.size).toBe(1)

    const reorderedRetry = {
      context: {
        syncError: BASE_SUBMISSION.context.syncError,
        viewport: {
          height: BASE_SUBMISSION.context.viewport.height,
          width: BASE_SUBMISSION.context.viewport.width,
        },
        sourceCounts: {
          pi: BASE_SUBMISSION.context.sourceCounts.pi,
          omp: BASE_SUBMISSION.context.sourceCounts.omp,
          codex: BASE_SUBMISSION.context.sourceCounts.codex,
          claude: BASE_SUBMISSION.context.sourceCounts.claude,
        },
        workDate: BASE_SUBMISSION.context.workDate,
        revision: BASE_SUBMISSION.context.revision,
        view: BASE_SUBMISSION.context.view,
        appVersion: BASE_SUBMISSION.context.appVersion,
      },
      createdAt: BASE_SUBMISSION.createdAt,
      followUp: BASE_SUBMISSION.followUp,
      message: BASE_SUBMISSION.message,
      kind: BASE_SUBMISSION.kind,
      id: BASE_SUBMISSION.id,
      protocolVersion: BASE_SUBMISSION.protocolVersion,
    }
    const reorderedResponse = await worker.fetch(
      feedbackRequest(JSON.stringify(reorderedRetry)),
      env,
    )
    expect(reorderedResponse.status).toBe(200)

    const changedSubmissions: ReadonlyArray<FeedbackSubmissionV1> = [
      { ...BASE_SUBMISSION, kind: "broken" },
      { ...BASE_SUBMISSION, message: "Different content under the same UUID." },
      { ...BASE_SUBMISSION, followUp: null },
      { ...BASE_SUBMISSION, createdAt: "2026-08-04T12:34:56.790Z" },
      { ...BASE_SUBMISSION, context: null },
      {
        ...BASE_SUBMISSION,
        context: { ...BASE_SUBMISSION.context, viewport: { width: 390, height: 844 } },
      },
    ]
    for (const changed of changedSubmissions) {
      const conflict = await worker.fetch(feedbackRequest(JSON.stringify(changed)), env)
      expect(conflict.status).toBe(409)
      expectCors(conflict)
    }
    expect(d1.rows.get(ID)?.message).toBe(BASE_SUBMISSION.message)
  })

  test("resolves insert races by rereading and comparing the winning UUID", async () => {
    const identical = fakeEnv()
    identical.d1.raceOnInsert = storedFrom(BASE_SUBMISSION)
    const identicalResponse = await worker.fetch(feedbackRequest(), identical.env)
    expect(identicalResponse.status).toBe(200)
    expect(await responseJson(identicalResponse)).toEqual({ protocolVersion: 1, id: ID, status: "received" })

    const changed = fakeEnv()
    changed.d1.raceOnInsert = { ...storedFrom(BASE_SUBMISSION), message: "the winning content differs" }
    const changedResponse = await worker.fetch(feedbackRequest(), changed.env)
    expect(changedResponse.status).toBe(409)

    const vanished = fakeEnv()
    vanished.d1.raceOnInsert = "vanish"
    const vanishedResponse = await worker.fetch(feedbackRequest(), vanished.env)
    expect(vanishedResponse.status).toBe(503)
    expectCors(vanishedResponse)
  })

  test("maps D1 read and write failures to detail-free 503 responses", async () => {
    for (const failure of ["select", "insert"] as const) {
      const { env, d1 } = fakeEnv()
      d1.fail = failure
      const response = await worker.fetch(feedbackRequest(), env)
      expect(response.status).toBe(503)
      const text = await response.text()
      expect(text).toContain("service unavailable")
      expect(text).not.toContain("private")
      expect(text).not.toContain(failure)
      expectCors(response)
    }
  })

  test("scheduled cleanup deletes expiry-bound rows with a parameterized inclusive cutoff", async () => {
    const { env, d1 } = fakeEnv()
    const submission = cloneSubmission()
    d1.rows.set("before", { ...storedFrom(submission), id: "before", expires_at: 999 })
    d1.rows.set("equal", { ...storedFrom(submission), id: "equal", expires_at: 1_000 })
    d1.rows.set("after", { ...storedFrom(submission), id: "after", expires_at: 1_001 })

    await worker.scheduled({ scheduledTime: 1_000 } as ScheduledController, env)

    expect([...d1.rows.keys()]).toEqual(["after"])
    const deletion = d1.statements.at(-1)!
    expect(deletion.sql).toBe("DELETE FROM feedback WHERE expires_at <= ?1")
    expect(deletion.bindings).toEqual([1_000])

    d1.fail = "delete"
    await expect(worker.scheduled({ scheduledTime: 2_000 } as ScheduledController, env)).rejects.toThrow(
      "private delete failure detail",
    )
  })
})
