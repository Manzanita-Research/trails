import { statfsSync } from "node:fs"
import { dirname } from "node:path"
import type { TrailsDb } from "./db"

export const RESOURCE_LIMITS = {
  records: 10_000,
  deviceRecords: 5_000,
  tuples: 100_000,
  deviceTuples: 50_000,
  imageBytes: 512 * 1024 * 1024,
  deviceImageBytes: 128 * 1024 * 1024,
  queue: 1_000,
  deviceQueue: 200,
  admissions: 1_000,
  deviceAdmissions: 200,
  calls: 300,
  deviceCalls: 100,
  attempts: 5,
  reserveBytes: 256 * 1024 * 1024,
  databaseBytes: 1024 * 1024 * 1024,
} as const

export class ResourceError extends Error {
  constructor(readonly code: "rate_limited" | "storage_full" | "summary_capacity", message: string) {
    super(message)
  }
}

export function checkDisk(db: TrailsDb): void {
  if (db.path === ":memory:") return
  const info = statfsSync(dirname(db.path))
  if (info.bavail * info.bsize < RESOURCE_LIMITS.reserveBytes) {
    throw new ResourceError("storage_full", "storage reserve reached; free disk space before retrying")
  }
}

// Run within the ingest transaction, once per changed batch. Failed checks roll
// back records, images, jobs, machine metadata, budgets and revision together.
export function checkStorage(db: TrailsDb, device?: string): void {
  const sqlite = db.sqlite
  for (const scope of device === undefined ? [null] : [null, device]) {
    const where = scope === null ? "" : " WHERE machine_id = ?"
    const args = scope === null ? [] : [scope]
    const row = sqlite.query(`SELECT
      (SELECT COUNT(*) FROM sessions${where}) + (SELECT COUNT(*) FROM captures${where}) AS records,
      (SELECT COUNT(*) FROM session_activity WHERE session_id IN (SELECT id FROM sessions${where})) +
      (SELECT COUNT(*) FROM capture_attention WHERE capture_id IN (SELECT id FROM captures${where})) AS tuples,
      (SELECT COALESCE(SUM(length(bytes)), 0) FROM capture_images
        WHERE capture_id IN (SELECT id FROM captures${where})) AS bytes`)
      .get(...Array.from({ length: 5 }, () => args).flat()) as { records: number; tuples: number; bytes: number }
    if (row.records > (scope === null ? RESOURCE_LIMITS.records : RESOURCE_LIMITS.deviceRecords) ||
        row.tuples > (scope === null ? RESOURCE_LIMITS.tuples : RESOURCE_LIMITS.deviceTuples) ||
        row.bytes > (scope === null ? RESOURCE_LIMITS.imageBytes : RESOURCE_LIMITS.deviceImageBytes)) {
      throw new ResourceError("storage_full", "stored history quota reached; archive history before retrying")
    }
  }
}

export function checkQueue(db: TrailsDb, device?: string): void {
  const row = db.sqlite.query(`SELECT
    (SELECT COUNT(*) FROM session_summary_jobs) + (SELECT COUNT(*) FROM day_summary_jobs) AS total,
    (SELECT COUNT(*) FROM session_summary_jobs j JOIN sessions s ON s.id = j.session_id
      WHERE s.machine_id = ?) +
    (SELECT COUNT(*) FROM day_summary_jobs WHERE project IN
      (SELECT project FROM sessions WHERE machine_id = ?)) AS device`).get(device ?? "", device ?? "") as { total: number; device: number }
  if (row.total > RESOURCE_LIMITS.queue || row.device > RESOURCE_LIMITS.deviceQueue) {
    throw new ResourceError("summary_capacity", "summary queue is full; retry after pending work completes")
  }
}

// Fixed, persistent 24-hour windows anchored at first use. One row per scope and
// kind, never an append-only log. Clock rollback cannot reset an active window.
export function chargeBudget(db: TrailsDb, kind: "admission" | "call", devices: readonly string[], now: number): void {
  const limit = kind === "admission" ? RESOURCE_LIMITS.admissions : RESOURCE_LIMITS.calls
  const deviceLimit = kind === "admission" ? RESOURCE_LIMITS.deviceAdmissions : RESOURCE_LIMITS.deviceCalls
  for (const scope of ["global", ...new Set(devices.map(id => `device:${id}`))]) {
    const row = db.sqlite.query("SELECT started_at, used FROM resource_budgets WHERE scope = ? AND kind = ?")
      .get(scope, kind) as { started_at: number; used: number } | null
    const reset = !row || now >= row.started_at + 86_400_000
    const used = reset ? 0 : row.used
    if (used >= (scope === "global" ? limit : deviceLimit)) {
      throw new ResourceError("summary_capacity", "daily summary budget exhausted; retry after its 24-hour window")
    }
    db.sqlite.query(`INSERT INTO resource_budgets(scope, kind, started_at, used) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, kind) DO UPDATE SET started_at = excluded.started_at, used = excluded.used`)
      .run(scope, kind, reset ? now : row.started_at, used + 1)
  }
}

// Shared across app instances for a database; bounded key count and no token-
// rotation bypass. The global gate also bounds slow body readers.
const gates = new WeakMap<TrailsDb, { active: number; start: number; used: number; buckets: Map<string, { start: number; used: number; active: number }> }>()
export function admitRequest(db: TrailsDb, device: string, now: number): () => void {
  let state = gates.get(db)
  if (!state) gates.set(db, state = { active: 0, start: now, used: 0, buckets: new Map() })
  if (now >= state.start + 60_000) { state.start = now; state.used = 0 }
  for (const [id, bucket] of state.buckets) {
    if (bucket.active === 0 && now >= bucket.start + 60_000) state.buckets.delete(id)
  }
  let bucket = state.buckets.get(device)
  if (!bucket) {
    if (state.buckets.size >= 256) throw new ResourceError("rate_limited", "collector capacity reached")
    state.buckets.set(device, bucket = { start: now, used: 0, active: 0 })
  }
  if (bucket.used >= 30 || bucket.active >= 1 || state.active >= 4 || state.used >= 120) {
    throw new ResourceError("rate_limited", "collector request limit reached; retry in 60 seconds")
  }
  bucket.used++
  bucket.active++
  state.active++
  state.used++
  return () => { bucket.active--; state.active-- }
}
