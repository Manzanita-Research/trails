import type { Database } from "bun:sqlite"
import { localParts, workdayOf } from "../shared/domain"

export interface RebuildDaySummaryJobsOptions {
  readonly boundary: number
  readonly timezone: string
  readonly now: number
  readonly clearSummaries: boolean
}

export function rebuildDaySummaryJobs(
  sqlite: Database,
  options: RebuildDaySummaryJobsOptions,
): void {
  const maximum = sqlite.query("SELECT MAX(generation) AS generation FROM day_summary_jobs").get() as {
    generation: number | null
  }
  const generation = (maximum.generation ?? 0) + 1
  const rows = sqlite
    .query(
      `SELECT s.project, a.utc_minute
       FROM sessions s JOIN session_activity a ON a.session_id = s.id
       ORDER BY s.project, a.utc_minute`,
    )
    .all() as Array<{ project: string; utc_minute: number }>
  const keys = new Set<string>()
  for (const row of rows) {
    const local = localParts(row.utc_minute * 60_000, options.timezone)
    keys.add(`${workdayOf(local.date, local.minute, options.boundary)}|${row.project}`)
  }

  if (options.clearSummaries) sqlite.query("DELETE FROM day_summaries").run()
  sqlite.query("DELETE FROM day_summary_jobs").run()
  const insert = sqlite.query(
    `INSERT INTO day_summary_jobs(work_date, project, boundary, generation, attempts, available_at, last_error)
     VALUES (?, ?, ?, ?, 0, ?, NULL)`,
  )
  for (const key of keys) {
    const separator = key.indexOf("|")
    insert.run(
      key.slice(0, separator),
      key.slice(separator + 1),
      options.boundary,
      generation,
      options.now,
    )
  }
}
