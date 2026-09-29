import type { Database } from "bun:sqlite"
import { Schema } from "effect"
import { CaptureTimingSchema, SessionTimingSchema } from "../shared/protocol"
import { rebuildDaySummaryJobs } from "./day-jobs"

const sessionTables = ["sessions", "session_activity", "session_summaries", "session_summary_jobs"]
const captureTables = ["captures", "capture_attention", "capture_images"]

// Copies intentionally have no foreign keys: recovery preserves the original
// records (including image bytes) independently of the active database rows.
export const TIMESTAMP_QUARANTINE_SQL = [...sessionTables, ...captureTables]
  .map((table) => `CREATE TABLE timestamp_quarantine_${table} AS SELECT * FROM ${table} WHERE 0;`)
  .join("\n")

function quarantine(sqlite: Database, tables: string[], foreignKey: string, id: number): void {
  for (const [index, table] of tables.entries()) {
    sqlite.query(
      `INSERT INTO timestamp_quarantine_${table} SELECT * FROM ${table} WHERE ${index === 0 ? "id" : foreignKey} = ?`,
    ).run(id)
  }
  sqlite.query(`DELETE FROM ${tables[0]} WHERE id = ?`).run(id)
}

// Runs inside the migration transaction, including archival, cascades, derived
// day state, revision, and user_version. A failure leaves the old DB intact.
export function recoverInvalidTimestamps(sqlite: Database, context: { readonly now: number }): void {
  const validSession = Schema.is(SessionTimingSchema)
  const validCapture = Schema.is(CaptureTimingSchema)
  const activity = sqlite.query(
    "SELECT utc_minute, event_count, user_event_count FROM session_activity WHERE session_id = ? ORDER BY utc_minute",
  )
  const attention = sqlite.query("SELECT utc_minute FROM capture_attention WHERE capture_id = ? ORDER BY utc_minute")
  let sessionsRecovered = false
  let capturesRecovered = false
  const sessions = sqlite.query("SELECT id, started_at, ended_at FROM sessions").all() as Array<{
    id: number; started_at: string; ended_at: string
  }>
  for (const row of sessions) {
    const buckets = activity.all(row.id) as Array<{ utc_minute: number; event_count: number; user_event_count: number }>
    if (validSession({
      start: row.started_at,
      end: row.ended_at,
      activity: buckets.map((bucket) => [bucket.utc_minute, bucket.event_count, bucket.user_event_count]),
    })) continue
    quarantine(sqlite, sessionTables, "session_id", row.id)
    sessionsRecovered = true
  }
  const captures = sqlite.query("SELECT id, started_at, ended_at FROM captures").all() as Array<{
    id: number; started_at: string; ended_at: string | null
  }>
  for (const row of captures) {
    const minutes = attention.all(row.id) as Array<{ utc_minute: number }>
    if (validCapture({
      startedAt: row.started_at,
      endedAt: row.ended_at,
      attentionMinutes: minutes.map((minute) => minute.utc_minute),
    })) continue
    quarantine(sqlite, captureTables, "capture_id", row.id)
    capturesRecovered = true
  }
  if (sessionsRecovered) {
    const settings = sqlite.query("SELECT boundary, timezone FROM settings WHERE id = 1").get() as {
      boundary: number; timezone: string
    }
    rebuildDaySummaryJobs(sqlite, { ...settings, now: context.now, clearSummaries: true })
  }
  if (sessionsRecovered || capturesRecovered) {
    sqlite.query("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'state_revision'").run()
  }
}
