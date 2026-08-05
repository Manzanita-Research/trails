import { Effect } from "effect"
import { createHash } from "node:crypto"
import { normalizeCwd, workdaysOfUtc, type UtcActivityTuple } from "../shared/domain"
import type { IngestRequestV2, IngestSessionV2 } from "../shared/protocol"
import type { TrailsDb } from "./db"

export interface IngestResult {
  readonly accepted: number
  readonly unchanged: number
  readonly revision: number
}

export class IngestError extends Error {
  readonly _tag = "IngestError"
  constructor(readonly cause: unknown) {
    super("session ingestion failed")
  }
}

type ExistingSession = {
  readonly id: number
  readonly project: string
  readonly digest_hash: string | null
  readonly content_hash: string
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex")

export function canonicalSessionJson(session: IngestSessionV2): string {
  return JSON.stringify({
    sourceSessionId: session.sourceSessionId,
    source: session.source,
    cwd: session.cwd,
    branch: session.branch,
    start: session.start,
    end: session.end,
    events: session.events,
    userEvents: session.userEvents,
    firstPrompt: session.firstPrompt,
    activity: session.activity,
    digest: session.digest,
  })
}

export function sessionContentHash(session: IngestSessionV2): string {
  return sha256(canonicalSessionJson(session))
}

function activityForSession(sqlite: TrailsDb["sqlite"], sessionId: number): UtcActivityTuple[] {
  const rows = sqlite
    .query(
      "SELECT utc_minute, event_count, user_event_count FROM session_activity WHERE session_id = ? ORDER BY utc_minute",
    )
    .all(sessionId) as Array<{
    utc_minute: number
    event_count: number
    user_event_count: number
  }>
  return rows.map((row) => [row.utc_minute, row.event_count, row.user_event_count])
}

function enqueueDay(
  sqlite: TrailsDb["sqlite"],
  workDate: string,
  project: string,
  boundary: number,
  availableAt: number,
): void {
  sqlite
    .query(
      `INSERT INTO day_summary_jobs(work_date, project, boundary, generation, attempts, available_at, last_error)
       VALUES (?, ?, ?, 1, 0, ?, NULL)
       ON CONFLICT(work_date, project, boundary) DO UPDATE SET
         generation = day_summary_jobs.generation + 1,
         attempts = 0,
         available_at = excluded.available_at,
         last_error = NULL`,
    )
    .run(workDate, project, boundary, availableAt)
}

export function ingestSessions(
  db: TrailsDb,
  input: IngestRequestV2,
  now = Date.now(),
): Effect.Effect<IngestResult, IngestError> {
  return Effect.try({
    try: () => {
      const sqlite = db.sqlite
      return sqlite.transaction(() => {
        let accepted = 0
        let unchanged = 0
        let changed = false
        const machine = sqlite.query("SELECT name FROM machines WHERE id = ?").get(input.device.id) as
          | { name: string }
          | null
        if (!machine) {
          sqlite
            .query(
              `INSERT INTO machines(id, name, first_seen_at, last_seen_at, last_ingested_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(input.device.id, input.device.name, now, now, now)
          changed = true
        } else {
          if (machine.name !== input.device.name) {
            sqlite.query("UPDATE machines SET name = ? WHERE id = ?").run(input.device.name, input.device.id)
            changed = true
          }
          sqlite
            .query("UPDATE machines SET last_seen_at = ?, last_ingested_at = ? WHERE id = ?")
            .run(now, now, input.device.id)
        }
        const settings = sqlite
          .query("SELECT boundary, timezone FROM settings WHERE id = 1")
          .get() as { boundary: number; timezone: string }

        for (const session of input.sessions) {
          const contentHash = sessionContentHash(session)
          const digestHash = session.digest === null ? null : sha256(session.digest)
          const project = normalizeCwd(session.cwd)
          const existing = sqlite
            .query(
              "SELECT id, project, digest_hash, content_hash FROM sessions WHERE machine_id = ? AND source = ? AND source_session_id = ?",
            )
            .get(input.device.id, session.source, session.sourceSessionId) as ExistingSession | null
          if (existing?.content_hash === contentHash) {
            unchanged++
            continue
          }

          const oldActivity = existing ? activityForSession(sqlite, existing.id) : []
          const oldDays = existing
            ? workdaysOfUtc(oldActivity, settings.boundary, settings.timezone)
            : new Set<string>()
          let sessionId: number
          if (existing) {
            sqlite
              .query(
                `UPDATE sessions SET cwd = ?, project = ?, branch = ?, started_at = ?, ended_at = ?,
                   event_count = ?, user_event_count = ?, first_prompt = ?, digest = ?, digest_hash = ?,
                   content_hash = ?, updated_at = ? WHERE id = ?`,
              )
              .run(
                session.cwd,
                project,
                session.branch,
                session.start,
                session.end,
                session.events,
                session.userEvents,
                session.firstPrompt,
                session.digest,
                digestHash,
                contentHash,
                now,
                existing.id,
              )
            sessionId = existing.id
            sqlite.query("DELETE FROM session_activity WHERE session_id = ?").run(sessionId)
          } else {
            const inserted = sqlite
              .query(
                `INSERT INTO sessions(machine_id, source, source_session_id, cwd, project, branch, started_at,
                   ended_at, event_count, user_event_count, first_prompt, digest, digest_hash, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
              )
              .get(
                input.device.id,
                session.source,
                session.sourceSessionId,
                session.cwd,
                project,
                session.branch,
                session.start,
                session.end,
                session.events,
                session.userEvents,
                session.firstPrompt,
                session.digest,
                digestHash,
                contentHash,
                now,
              ) as { id: number }
            sessionId = inserted.id
          }

          const insertActivity = sqlite.query(
            "INSERT INTO session_activity(session_id, utc_minute, event_count, user_event_count) VALUES (?, ?, ?, ?)",
          )
          for (const [utcMinute, eventCount, userEventCount] of session.activity) {
            insertActivity.run(sessionId, utcMinute, eventCount, userEventCount)
          }

          const digestChanged = !existing || existing.digest_hash !== digestHash
          const settleAt = digestChanged && digestHash !== null ? now + 5 * 60_000 : now
          if (digestChanged) {
            sqlite.query("DELETE FROM session_summaries WHERE session_id = ?").run(sessionId)
            if (digestHash === null) {
              sqlite.query("DELETE FROM session_summary_jobs WHERE session_id = ?").run(sessionId)
            } else {
              sqlite
                .query(
                  `INSERT INTO session_summary_jobs(session_id, digest_hash, attempts, available_at, last_error)
                   VALUES (?, ?, 0, ?, NULL)
                   ON CONFLICT(session_id) DO UPDATE SET digest_hash = excluded.digest_hash,
                     attempts = 0, available_at = excluded.available_at, last_error = NULL`,
                )
                .run(sessionId, digestHash, settleAt)
            }
          }

          const affected = new Set<string>()
          for (const day of oldDays) affected.add(`${day}|${existing?.project ?? project}`)
          for (const day of workdaysOfUtc(session.activity, settings.boundary, settings.timezone)) {
            affected.add(`${day}|${project}`)
          }
          for (const key of affected) {
            const separator = key.indexOf("|")
            enqueueDay(sqlite, key.slice(0, separator), key.slice(separator + 1), settings.boundary, settleAt)
          }
          accepted++
          changed = true
        }

        const revisionRow = sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get() as {
          value: string
        }
        let revision = Number(revisionRow.value)
        if (changed) {
          revision++
          sqlite.query("UPDATE meta SET value = ? WHERE key = 'state_revision'").run(String(revision))
        }
        return { accepted, unchanged, revision }
      })()
    },
    catch: (cause) => new IngestError(cause),
  })
}
