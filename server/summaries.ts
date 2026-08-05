import { Effect, Schedule } from "effect"
import { createHash } from "node:crypto"
import { localParts, workdayOf } from "../shared/domain"
import type { SummaryRuntimeStatus } from "./connectors/manager"
import type { InferenceResult, Summarizer } from "./connectors/types"
import type { TrailsDb } from "./db"

export interface SummaryPollOptions {
  readonly db: TrailsDb
  /** Re-evaluated every poll so config changes apply without a restart. */
  readonly summarizer: () => Summarizer | null
  readonly status?: SummaryRuntimeStatus
  readonly now?: number
  readonly inFlight?: Set<string>
}

type SessionJob = {
  readonly kind: "session"
  readonly key: string
  readonly sessionId: number
  readonly digestHash: string
  readonly attempts: number
  readonly availableAt: number
  readonly digest: string
}

type DayJob = {
  readonly kind: "day"
  readonly key: string
  readonly workDate: string
  readonly project: string
  readonly boundary: number
  readonly generation: number
  readonly attempts: number
  readonly availableAt: number
}

type SummaryJob = SessionJob | DayJob

type DayMember = {
  readonly id: number
  readonly digestHash: string | null
  readonly summary: string
  readonly pending: boolean
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

function incrementRevision(db: TrailsDb): void {
  const row = db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get() as { value: string }
  db.sqlite.query("UPDATE meta SET value = ? WHERE key = 'state_revision'").run(String(Number(row.value) + 1))
}

function sanitizedError(error: unknown): string {
  return error instanceof Error ? error.name.slice(0, 120) : "InferenceError"
}

function retryAt(attempts: number, now: number): number {
  return now + Math.min(2 ** attempts * 60_000, 60 * 60_000)
}


function selectJobs(db: TrailsDb, now: number, inFlight: Set<string>): SummaryJob[] {
  const sessionJobs = db.sqlite
    .query(
      `SELECT j.session_id, j.digest_hash, j.attempts, j.available_at, s.digest
       FROM session_summary_jobs j JOIN sessions s ON s.id = j.session_id
       WHERE j.available_at <= ? ORDER BY j.available_at, j.session_id LIMIT 4`,
    )
    .all(now) as Array<{
    session_id: number
    digest_hash: string
    attempts: number
    available_at: number
    digest: string
  }>
  const dayJobs = db.sqlite
    .query(
      `SELECT work_date, project, boundary, generation, attempts, available_at
       FROM day_summary_jobs WHERE available_at <= ? ORDER BY available_at, work_date, project LIMIT 4`,
    )
    .all(now) as Array<{
    work_date: string
    project: string
    boundary: number
    generation: number
    attempts: number
    available_at: number
  }>
  const jobs: SummaryJob[] = [
    ...sessionJobs.map((job): SessionJob => ({
      kind: "session",
      key: `session:${job.session_id}`,
      sessionId: job.session_id,
      digestHash: job.digest_hash,
      attempts: job.attempts,
      availableAt: job.available_at,
      digest: job.digest,
    })),
    ...dayJobs.map((job): DayJob => ({
      kind: "day",
      key: `day:${job.work_date}|${job.project}|${job.boundary}`,
      workDate: job.work_date,
      project: job.project,
      boundary: job.boundary,
      generation: job.generation,
      attempts: job.attempts,
      availableAt: job.available_at,
    })),
  ]
  return jobs
    .filter((job) => !inFlight.has(job.key))
    .filter((job) => job.kind === "session" || !dayMembers(db, job).some((member) => member.pending))
    .sort((a, b) => a.availableAt - b.availableAt || a.key.localeCompare(b.key))
    .slice(0, Math.max(0, 2 - inFlight.size))
}

function dayMembers(db: TrailsDb, job: DayJob): DayMember[] {
  const rows = db.sqlite
    .query(
      `SELECT s.id, s.digest_hash, s.first_prompt, ss.summary, sj.session_id AS pending_id,
         a.utc_minute
       FROM sessions s
       JOIN session_activity a ON a.session_id = s.id
       LEFT JOIN session_summaries ss ON ss.session_id = s.id
       LEFT JOIN session_summary_jobs sj ON sj.session_id = s.id
       WHERE s.project = ? ORDER BY s.started_at, s.id, a.utc_minute`,
    )
    .all(job.project) as Array<{
    id: number
    digest_hash: string | null
    first_prompt: string | null
    summary: string | null
    pending_id: number | null
    utc_minute: number
  }>
  const timezone = (
    db.sqlite.query("SELECT timezone FROM settings WHERE id = 1").get() as { timezone: string }
  ).timezone
  const members = new Map<number, DayMember>()
  for (const row of rows) {
    const local = localParts(row.utc_minute * 60_000, timezone)
    if (workdayOf(local.date, local.minute, job.boundary) !== job.workDate || members.has(row.id)) continue
    members.set(row.id, {
      id: row.id,
      digestHash: row.digest_hash,
      summary: row.summary ?? row.first_prompt ?? "Coding session",
      pending: row.pending_id !== null,
    })
  }
  return [...members.values()]
}

function memberHash(members: ReadonlyArray<DayMember>): string {
  return sha256(JSON.stringify(members.map((member) => [member.id, member.digestHash, member.summary])))
}

function completeSession(db: TrailsDb, job: SessionJob, result: InferenceResult, now: number): void {
  db.sqlite.transaction(() => {
    const current = db.sqlite
      .query(
        `SELECT s.digest_hash AS session_hash, j.digest_hash AS job_hash
         FROM sessions s JOIN session_summary_jobs j ON j.session_id = s.id WHERE s.id = ?`,
      )
      .get(job.sessionId) as { session_hash: string | null; job_hash: string } | null
    if (!current || current.session_hash !== job.digestHash || current.job_hash !== job.digestHash) return
    const previous = db.sqlite.query("SELECT summary FROM session_summaries WHERE session_id = ?").get(job.sessionId) as
      | { summary: string }
      | null
    db.sqlite
      .query(
        `INSERT INTO session_summaries(session_id, digest_hash, model, summary, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET digest_hash = excluded.digest_hash, model = excluded.model,
           summary = excluded.summary, updated_at = excluded.updated_at`,
      )
      .run(job.sessionId, job.digestHash, result.model, result.text, now)
    db.sqlite.query("DELETE FROM session_summary_jobs WHERE session_id = ?").run(job.sessionId)
    if (previous?.summary !== result.text) incrementRevision(db)
  })()
}

function failSession(db: TrailsDb, job: SessionJob, error: unknown, now: number): void {
  db.sqlite
    .query(
      `UPDATE session_summary_jobs SET attempts = attempts + 1, available_at = ?, last_error = ?
       WHERE session_id = ? AND digest_hash = ?`,
    )
    .run(retryAt(job.attempts, now), sanitizedError(error), job.sessionId, job.digestHash)
}

function completeDay(
  db: TrailsDb,
  job: DayJob,
  capturedHash: string,
  result: InferenceResult,
  now: number,
): void {
  db.sqlite.transaction(() => {
    const current = db.sqlite
      .query("SELECT generation FROM day_summary_jobs WHERE work_date = ? AND project = ? AND boundary = ?")
      .get(job.workDate, job.project, job.boundary) as { generation: number } | null
    if (!current || current.generation !== job.generation || memberHash(dayMembers(db, job)) !== capturedHash) return
    const previous = db.sqlite
      .query("SELECT summary FROM day_summaries WHERE work_date = ? AND project = ? AND boundary = ?")
      .get(job.workDate, job.project, job.boundary) as { summary: string } | null
    db.sqlite
      .query(
        `INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_date, project, boundary) DO UPDATE SET model = excluded.model,
           summary = excluded.summary, updated_at = excluded.updated_at`,
      )
      .run(job.workDate, job.project, job.boundary, result.model, result.text, now)
    db.sqlite
      .query("DELETE FROM day_summary_jobs WHERE work_date = ? AND project = ? AND boundary = ? AND generation = ?")
      .run(job.workDate, job.project, job.boundary, job.generation)
    if (previous?.summary !== result.text) incrementRevision(db)
  })()
}

function clearEmptyDay(db: TrailsDb, job: DayJob): void {
  db.sqlite.transaction(() => {
    const current = db.sqlite
      .query("SELECT generation FROM day_summary_jobs WHERE work_date = ? AND project = ? AND boundary = ?")
      .get(job.workDate, job.project, job.boundary) as { generation: number } | null
    if (!current || current.generation !== job.generation) return
    const removed = db.sqlite
      .query("DELETE FROM day_summaries WHERE work_date = ? AND project = ? AND boundary = ? RETURNING work_date")
      .get(job.workDate, job.project, job.boundary)
    db.sqlite
      .query("DELETE FROM day_summary_jobs WHERE work_date = ? AND project = ? AND boundary = ? AND generation = ?")
      .run(job.workDate, job.project, job.boundary, job.generation)
    if (removed) incrementRevision(db)
  })()
}

function failDay(db: TrailsDb, job: DayJob, error: unknown, now: number): void {
  db.sqlite
    .query(
      `UPDATE day_summary_jobs SET attempts = attempts + 1, available_at = ?, last_error = ?
       WHERE work_date = ? AND project = ? AND boundary = ? AND generation = ?`,
    )
    .run(
      retryAt(job.attempts, now),
      sanitizedError(error),
      job.workDate,
      job.project,
      job.boundary,
      job.generation,
    )
}

function processJob(
  db: TrailsDb,
  client: Summarizer | null,
  job: SummaryJob,
  now: number,
  status?: SummaryRuntimeStatus,
): Effect.Effect<void, never> {
  const summarize = (kind: "session" | "day", input: string) => {
    if (!client) return null
    if (status) status.lastAttemptAt = now
    return client.summarize(kind, input).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (status) {
            status.lastSuccessAt = now
            status.lastErrorClass = null
          }
        }),
      ),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (status) status.lastErrorClass = error.errorClass
        }),
      ),
    )
  }
  if (job.kind === "session") {
    const run = summarize("session", job.digest.slice(0, 9_000))
    if (!run) return Effect.void
    return run.pipe(
      Effect.tap((result) => Effect.sync(() => completeSession(db, job, result, now))),
      Effect.catchAll((error) => Effect.sync(() => failSession(db, job, error, now))),
      Effect.asVoid,
    )
  }
  const members = dayMembers(db, job)
  if (members.length === 0) return Effect.sync(() => clearEmptyDay(db, job))
  if (members.some((member) => member.pending)) return Effect.void
  const capturedHash = memberHash(members)
  if (members.length === 1) {
    return Effect.sync(() => completeDay(db, job, capturedHash, { text: members[0].summary, model: "copy" }, now))
  }
  const memberText = members.map((member) => `- ${member.summary.slice(0, 600)}`).join("\n")
  const input = `Project: ${job.project}\nDay: ${job.workDate}\nSession summaries:\n${memberText}`.slice(0, 12_000)
  const run = summarize("day", input)
  if (!run) return Effect.void
  return run.pipe(
    Effect.tap((result) => Effect.sync(() => completeDay(db, job, capturedHash, result, now))),
    Effect.catchAll((error) => Effect.sync(() => failDay(db, job, error, now))),
    Effect.asVoid,
  )
}

export function runSummaryPoll(options: SummaryPollOptions): Effect.Effect<number, never> {
  const now = options.now ?? Date.now()
  const inFlight = options.inFlight ?? new Set<string>()
  const client = options.summarizer()
  const jobs = selectJobs(options.db, now, inFlight)
  for (const job of jobs) inFlight.add(job.key)
  return Effect.forEach(
    jobs,
    (job) =>
      processJob(options.db, client, job, now, options.status).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(job.key))),
      ),
    { concurrency: 2 },
  ).pipe(Effect.map(() => jobs.length))
}

export function summarySupervisor(options: Omit<SummaryPollOptions, "now">): Effect.Effect<never, never> {
  return runSummaryPoll(options).pipe(
    Effect.repeat(Schedule.spaced("30 seconds")),
    Effect.flatMap(() => Effect.never),
  )
}
