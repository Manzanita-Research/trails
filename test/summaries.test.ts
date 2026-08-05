import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { IngestSessionV2 } from "../shared/protocol"
import { openDatabase, type TrailsDb } from "../server/db"
import { ingestSessions } from "../server/ingest"
import { runSummaryPoll } from "../server/summaries"
import {
  SummarizeError,
  type InferenceResult,
  type Summarizer,
} from "../server/connectors/types"

const START = Date.parse("2026-08-01T12:00:00.000Z")
const SETTLED = START + 5 * 60_000
const PROJECT = "code/manzanita-research/trails"

function session(
  sourceSessionId: string,
  digest: string,
  options: { readonly cwd?: string; readonly date?: string; readonly minute?: number } = {},
): IngestSessionV2 {
  return {
    sourceSessionId,
    source: "omp",
    cwd: options.cwd ?? `/Users/jem/${PROJECT}`,
    branch: "feat/tests",
    start: "2026-08-01T12:00:00.000Z",
    end: "2026-08-01T12:05:00.000Z",
    events: 2,
    userEvents: 1,
    firstPrompt: `Prompt for ${sourceSessionId}`,
    activity: [[
      Math.floor(Date.parse(`${options.date ?? "2026-08-01"}T00:00:00-07:00`) / 60_000) +
        (options.minute ?? 600),
      2,
      1,
    ]],
    digest,
  }
}

async function ingest(db: TrailsDb, now: number, ...sessions: IngestSessionV2[]): Promise<void> {
  await Effect.runPromise(
    ingestSessions(
      db,
      {
        protocolVersion: 2,
        device: { id: "test-machine", name: "Test Machine" },
        sessions,
      },
      now,
    ),
  )
}

function scalar<T>(db: TrailsDb, sql: string, ...values: Array<string | number>): T | null {
  return db.sqlite.query(sql).get(...values) as T | null
}

interface DeferredCall {
  readonly kind: "session" | "day"
  readonly input: string
  resolve(result?: InferenceResult): void
  reject(error?: SummarizeError): void
}

function deferredInference(): {
  readonly inference: Summarizer
  readonly calls: DeferredCall[]
  waitForCalls(count: number): Promise<void>
} {
  const calls: DeferredCall[] = []
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  const inference: Summarizer = {
    provider: "openrouter",
    model: "fake-model",
    summarize: (kind, input) =>
      Effect.tryPromise({
        try: () =>
          new Promise<InferenceResult>((resolve, reject) => {
            calls.push({
              kind,
              input,
              resolve: (result = { text: `summary for ${input}`, model: "fake-model" }) => resolve(result),
              reject: (error = new SummarizeError("network")) => reject(error),
            })
            for (let index = waiters.length - 1; index >= 0; index--) {
              if (calls.length < waiters[index].count) continue
              waiters[index].resolve()
              waiters.splice(index, 1)
            }
          }),
        catch: (cause) => (cause instanceof SummarizeError ? cause : new SummarizeError("network")),
      }),
  }
  return {
    inference,
    calls,
    waitForCalls: (count) => {
      if (calls.length >= count) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.push({ count, resolve }))
    },
  }
}

function sessionIds(db: TrailsDb): Array<{ id: number; digest_hash: string }> {
  return db.sqlite.query("SELECT id, digest_hash FROM sessions ORDER BY id").all() as Array<{
    id: number
    digest_hash: string
  }>
}

function makeSessionSummariesReady(db: TrailsDb, summaries: ReadonlyArray<string>, now = SETTLED): void {
  const rows = sessionIds(db)
  expect(rows).toHaveLength(summaries.length)
  for (let index = 0; index < rows.length; index++) {
    db.sqlite
      .query(
        "INSERT INTO session_summaries(session_id, digest_hash, model, summary, updated_at) VALUES (?, ?, 'fixture', ?, ?)",
      )
      .run(rows[index].id, rows[index].digest_hash, summaries[index], now)
  }
  db.sqlite.exec("DELETE FROM session_summary_jobs")
  db.sqlite.query("UPDATE day_summary_jobs SET available_at = ?, attempts = 0, last_error = NULL").run(now)
}

describe("summary work", () => {
  let db: TrailsDb

  beforeEach(() => {
    db = openDatabase(":memory:")
  })

  afterEach(() => {
    db.close()
  })

  test("pending day jobs cannot starve the session summaries they depend on", async () => {
    await ingest(
      db,
      START,
      session("dependency-a", "digest a", { date: "2026-08-01" }),
      session("dependency-b", "digest b", { date: "2026-08-02" }),
      session("dependency-c", "digest c", { date: "2026-08-03" }),
    )
    db.sqlite.query("UPDATE day_summary_jobs SET available_at = ?").run(START)
    const kinds: Array<"session" | "day"> = []
    const inference: Summarizer = {
      provider: "openrouter",
      model: "fake-model",
      summarize: (kind) => {
        kinds.push(kind)
        return Effect.succeed({ text: `${kind} summary`, model: "fake-model" })
      },
    }

    expect(await Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))).toBe(2)
    expect(kinds).toEqual(["session", "session"])
    expect(db.sqlite.query("SELECT count(*) AS count FROM session_summaries").get()).toEqual({ count: 2 })
  })

  test("waits five minutes, persists retry state, and resumes at the exact backoff", async () => {
    await ingest(db, START, session("settling", "private bounded digest"))
    db.sqlite.exec("DELETE FROM day_summary_jobs")

    const jobAtIngest = scalar<{ attempts: number; available_at: number; last_error: string | null }>(
      db,
      "SELECT attempts, available_at, last_error FROM session_summary_jobs",
    )
    expect(jobAtIngest).toEqual({ attempts: 0, available_at: SETTLED, last_error: null })

    let calls = 0
    const inference: Summarizer = {
      provider: "openrouter",
      model: "fake-model",
      summarize: () => {
        calls++
        return calls === 1
          ? Effect.fail(new SummarizeError("network"))
          : Effect.succeed({ text: "The work was summarized.", model: "fake-model" })
      },
    }

    expect(await Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED - 1 }))).toBe(0)
    expect(calls).toBe(0)

    expect(await Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))).toBe(1)
    expect(calls).toBe(1)
    expect(
      scalar<{ attempts: number; available_at: number; last_error: string }>(
        db,
        "SELECT attempts, available_at, last_error FROM session_summary_jobs",
      ),
    ).toEqual({ attempts: 1, available_at: SETTLED + 60_000, last_error: "network" })

    // A fresh in-flight set models the next supervisor poll (including one after a restart).
    expect(
      await Effect.runPromise(
        runSummaryPoll({ db, summarizer: () => inference, now: SETTLED + 60_000 - 1, inFlight: new Set<string>() }),
      ),
    ).toBe(0)
    expect(calls).toBe(1)

    expect(
      await Effect.runPromise(
        runSummaryPoll({ db, summarizer: () => inference, now: SETTLED + 60_000, inFlight: new Set<string>() }),
      ),
    ).toBe(1)
    expect(calls).toBe(2)
    expect(scalar(db, "SELECT session_id FROM session_summary_jobs")).toBeNull()
    expect(scalar<{ summary: string }>(db, "SELECT summary FROM session_summaries")).toEqual({
      summary: "The work was summarized.",
    })
  })

  test("never exceeds two concurrent requests across overlapping polls", async () => {
    await ingest(
      db,
      START,
      session("concurrent-a", "digest a"),
      session("concurrent-b", "digest b"),
      session("concurrent-c", "digest c"),
    )
    db.sqlite.exec("DELETE FROM day_summary_jobs")
    const { inference, calls, waitForCalls } = deferredInference()
    const inFlight = new Set<string>()

    const firstPoll = Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED, inFlight }))
    await waitForCalls(2)
    const overlappingPoll = Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED, inFlight }))
    await Promise.resolve()
    const requestsWhileFirstPollWasBlocked = calls.length
    const uniqueInputs = new Set(calls.map((call) => call.input)).size

    for (const call of calls) call.resolve({ text: "done", model: "fake-model" })
    await Promise.all([firstPoll, overlappingPoll])

    expect(requestsWhileFirstPollWasBlocked).toBe(2)
    expect(uniqueInputs).toBe(2)
    expect(inFlight.size).toBe(0)
  })

  test("stale session success and failure cannot replace a newer digest job", async () => {
    await ingest(db, START, session("stale-success", "old success digest"), session("stale-failure", "old failure digest"))
    db.sqlite.exec("DELETE FROM day_summary_jobs")
    const { inference, calls, waitForCalls } = deferredInference()

    const poll = Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))
    await waitForCalls(2)

    await ingest(
      db,
      SETTLED + 10,
      session("stale-success", "new success digest"),
      session("stale-failure", "new failure digest"),
    )
    const successCall = calls.find((call) => call.input === "old success digest")
    const failureCall = calls.find((call) => call.input === "old failure digest")
    expect(successCall).toBeDefined()
    expect(failureCall).toBeDefined()
    successCall!.resolve({ text: "obsolete summary", model: "fake-model" })
    failureCall!.reject(new SummarizeError("provider_rejected"))
    await poll

    expect(db.sqlite.query("SELECT * FROM session_summaries").all()).toEqual([])
    const jobs = db.sqlite
      .query(
        `SELECT s.source_session_id, j.digest_hash, j.attempts, j.last_error
         FROM session_summary_jobs j JOIN sessions s ON s.id = j.session_id
         ORDER BY s.source_session_id`,
      )
      .all() as Array<{
      source_session_id: string
      digest_hash: string
      attempts: number
      last_error: string | null
    }>
    expect(jobs).toEqual([
      {
        source_session_id: "stale-failure",
        digest_hash: createHash("sha256").update("new failure digest", "utf8").digest("hex"),
        attempts: 0,
        last_error: null,
      },
      {
        source_session_id: "stale-success",
        digest_hash: createHash("sha256").update("new success digest", "utf8").digest("hex"),
        attempts: 0,
        last_error: null,
      },
    ])
  })

  test("a newer day generation rejects an older in-flight completion", async () => {
    await ingest(db, START, session("generation-a", "digest a"), session("generation-b", "digest b"))
    makeSessionSummariesReady(db, ["first session", "second session"])
    const original = scalar<{ generation: number }>(db, "SELECT generation FROM day_summary_jobs")!
    const { inference, calls, waitForCalls } = deferredInference()

    const poll = Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))
    await waitForCalls(1)
    expect(calls[0].kind).toBe("day")
    db.sqlite.query("UPDATE day_summary_jobs SET generation = generation + 1 WHERE work_date = ? AND project = ?").run(
      "2026-08-01",
      PROJECT,
    )
    calls[0].resolve({ text: "obsolete combined day", model: "fake-model" })
    await poll

    expect(scalar(db, "SELECT summary FROM day_summaries")).toBeNull()
    expect(scalar<{ generation: number; attempts: number }>(db, "SELECT generation, attempts FROM day_summary_jobs")).toEqual({
      generation: original.generation + 1,
      attempts: 0,
    })
  })

  test("a changed member set rejects an in-flight day completion", async () => {
    await ingest(db, START, session("members-a", "digest a"), session("members-b", "digest b"))
    makeSessionSummariesReady(db, ["first session", "second session"])
    const { inference, calls, waitForCalls } = deferredInference()

    const poll = Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))
    await waitForCalls(1)
    const firstId = sessionIds(db)[0].id
    db.sqlite.query("UPDATE session_summaries SET summary = ? WHERE session_id = ?").run("newer member summary", firstId)
    calls[0].resolve({ text: "obsolete combined day", model: "fake-model" })
    await poll

    expect(scalar(db, "SELECT summary FROM day_summaries")).toBeNull()
    expect(scalar<{ attempts: number }>(db, "SELECT attempts FROM day_summary_jobs")).toEqual({ attempts: 0 })
  })

  test("copies a one-member day without inference", async () => {
    await ingest(db, START, session("one-member", "digest"))
    makeSessionSummariesReady(db, ["The only session summary."])
    let calls = 0
    const inference: Summarizer = {
      provider: "openrouter",
      model: "fake-model",
      summarize: () => {
        calls++
        return Effect.succeed({ text: "should not be used", model: "fake-model" })
      },
    }

    expect(await Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: SETTLED }))).toBe(1)
    expect(calls).toBe(0)
    expect(
      scalar<{ summary: string; model: string }>(db, "SELECT summary, model FROM day_summaries"),
    ).toEqual({ summary: "The only session summary.", model: "copy" })
    expect(scalar(db, "SELECT generation FROM day_summary_jobs")).toBeNull()
  })

  test("deletes a stored summary when its rebuilt day has no members", async () => {
    db.sqlite
      .query(
        "INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at) VALUES (?, ?, 6, 'old', 'stale day', ?)",
      )
      .run("2026-08-01", PROJECT, START)
    db.sqlite
      .query(
        `INSERT INTO day_summary_jobs(work_date, project, boundary, generation, attempts, available_at, last_error)
         VALUES (?, ?, 6, 1, 0, ?, NULL)`,
      )
      .run("2026-08-01", PROJECT, START)
    let calls = 0
    const inference: Summarizer = {
      provider: "openrouter",
      model: "fake-model",
      summarize: () => {
        calls++
        return Effect.succeed({ text: "should not be used", model: "fake-model" })
      },
    }

    expect(await Effect.runPromise(runSummaryPoll({ db, summarizer: () => inference, now: START }))).toBe(1)
    expect(calls).toBe(0)
    expect(db.sqlite.query("SELECT * FROM day_summaries").all()).toEqual([])
    expect(db.sqlite.query("SELECT * FROM day_summary_jobs").all()).toEqual([])
    expect(scalar<{ value: string }>(db, "SELECT value FROM meta WHERE key = 'state_revision'")).toEqual({ value: "1" })
  })
})
