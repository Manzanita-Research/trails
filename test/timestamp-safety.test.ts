import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapOf, createApp } from "../server/app"
import { ingestCaptures } from "../server/captures"
import { openDatabase, type TrailsDb } from "../server/db"
import { ingestSessions } from "../server/ingest"
import { MIGRATIONS } from "../server/migrations"
import { localActivityOf, localParts, workdaysOfUtc } from "../shared/domain"
import {
  BootstrapCaptureV1Schema, BootstrapSessionV1Schema, CanonicalTimestampSchema,
  CaptureTimingSchema, SessionTimingSchema, LocalDateSchema, MAX_TIMESTAMP_MS,
  MAX_UTC_MINUTE, UtcMinuteSchema, decodeExact,
  type GranolaCaptureV1, type IngestSessionV2,
} from "../shared/protocol"

const now = Date.parse("2026-09-16T12:00:00.000Z")
const minute = now / 60_000
const device = { id: "test-device", name: "Test device" }
const capture = (id: string): GranolaCaptureV1 => ({
  source: "granola", sourceRecordId: id, project: null, projectHint: null,
  title: "Test capture", startedAt: new Date(now).toISOString(), endedAt: null,
  summaryInput: "Test notes", attentionMinutes: [minute],
  payload: { attendeeCount: 1, folders: [], webUrl: null }, images: [],
})
const session = (id: string): IngestSessionV2 => ({
  sourceSessionId: id, source: "claude", cwd: "/work/test", branch: null,
  start: new Date(now).toISOString(), end: new Date(now + 60_000).toISOString(),
  events: 2, userEvents: 1, firstPrompt: null, digest: "Test digest", activity: [[minute, 2, 1]],
})
const captures = (items: GranolaCaptureV1[]) => ({ protocolVersion: 1 as const, device, captures: items })
const sessions = (items: IngestSessionV2[]) => ({ protocolVersion: 2 as const, device, sessions: items })
const databases: TrailsDb[] = []
const roots: string[] = []
const open = (path = ":memory:", timezone = "UTC") => {
  const db = openDatabase(path, { defaultTimezone: timezone, now })
  databases.push(db)
  return db
}
const close = (db: TrailsDb) => {
  databases.splice(databases.indexOf(db), 1)
  db.close()
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function post(app: ReturnType<typeof createApp>, path: string, body: unknown) {
  return app(new Request(`http://trails.test${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }))
}

function snapshot(db: TrailsDb) {
  return Object.fromEntries([
    "machines", "sessions", "session_activity", "session_summary_jobs", "day_summary_jobs",
    "captures", "capture_attention", "capture_images", "meta",
  ].map((table) => [table, db.sqlite.query(`SELECT * FROM ${table}`).all()]))
}

describe("supported timestamp range", () => {
  test("rejects unsafe, unrepresentable, and out-of-calendar minutes", () => {
    for (const value of [-1, 0.5, MAX_UTC_MINUTE + 1, Number.MAX_SAFE_INTEGER, 144_000_000_000,
      Number.MAX_VALUE, Infinity, -Infinity, NaN]) {
      expect(() => decodeExact(UtcMinuteSchema, value)).toThrow()
      expect(() => decodeExact(CaptureTimingSchema, {
        startedAt: capture("bad").startedAt, endedAt: null, attentionMinutes: [value],
      })).toThrow()
      expect(() => decodeExact(SessionTimingSchema, {
        start: session("bad").start, end: session("bad").end, activity: [[value, 2, 1]],
      })).toThrow()
    }
  })

  test("rejects extended/negative years and noncanonical or impossible dates", () => {
    for (const value of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z",
      "+275760-09-13T00:00:00.000Z", "0000-01-01T00:00:00.000Z", "1969-12-31T23:59:59.999Z",
      "2026-02-30T00:00:00.000Z", "2026-01-01T00:00:00Z", "9999-12-31T00:00:00.000Z"]) {
      expect(() => decodeExact(CanonicalTimestampSchema, value)).toThrow()
    }
  })

  test("accepts exact endpoints and keeps localization/workdays within the calendar", async () => {
    for (const timezone of ["UTC", "Pacific/Kiritimati", "Etc/GMT+12", "America/Los_Angeles"]) {
      const db = open(":memory:", timezone)
      for (const ms of [0, MAX_TIMESTAMP_MS]) {
        const timestamp = new Date(ms).toISOString()
        const utcMinute = Math.floor(ms / 60_000)
        expect(decodeExact(CanonicalTimestampSchema, timestamp)).toBe(timestamp)
        expect(decodeExact(UtcMinuteSchema, utcMinute)).toBe(utcMinute)
        const local = localParts(ms, timezone)
        expect(decodeExact(LocalDateSchema, local.date)).toBe(local.date)
        for (const day of workdaysOfUtc([[utcMinute, 2, 1]], 7, timezone)) {
          expect(decodeExact(LocalDateSchema, day)).toBe(day)
        }
        await Effect.runPromise(ingestSessions(db, sessions([{
          ...session(String(ms)), start: timestamp, end: timestamp, activity: [[utcMinute, 2, 1]],
        }]), now))
        await Effect.runPromise(ingestCaptures(db, captures([{
          ...capture(String(ms)), startedAt: timestamp, endedAt: timestamp, attentionMinutes: [utcMinute],
        }]), now))
      }
      expect(bootstrapOf(db, now).sessions).toHaveLength(2)
      expect(bootstrapOf(db, now).captures).toHaveLength(2)
    }
  })

  test("uses inclusive minute buckets, ordered intervals, and an open end for null captures", () => {
    const start = new Date(now + 59_999).toISOString()
    const end = new Date(now + 60_000).toISOString()
    const value = { startedAt: start, endedAt: end, attentionMinutes: [minute, minute + 1] }
    expect(decodeExact(CaptureTimingSchema, value)).toEqual(value)
    expect(decodeExact(SessionTimingSchema, {
      start, end, activity: [[minute, 1, 1], [minute + 1, 1, 0]],
    }).activity).toHaveLength(2)
    for (const minutes of [[minute - 1], [minute + 2]]) {
      expect(() => decodeExact(CaptureTimingSchema, { ...value, attentionMinutes: minutes })).toThrow()
      expect(() => decodeExact(SessionTimingSchema, { start, end, activity: [[minutes[0], 2, 1]] })).toThrow()
    }
    expect(decodeExact(CaptureTimingSchema, {
      ...value, endedAt: null, attentionMinutes: [minute + 2],
    }).endedAt).toBeNull()
    expect(() => decodeExact(CaptureTimingSchema, { ...value, startedAt: end, endedAt: start })).toThrow()
    expect(() => decodeExact(SessionTimingSchema, { start: end, end: start, activity: [[minute, 2, 1]] })).toThrow()
  })

  test("bootstrap rejects unsupported timestamps and reversed intervals too", () => {
    const base = session("test")
    const wire = {
      id: "1", machine: device, source: base.source, cwd: base.cwd, branch: base.branch,
      start: base.start, end: base.end, events: 2, userEvents: 1, firstPrompt: null,
      activity: localActivityOf(base.activity, "UTC"),
    }
    const { sourceRecordId, ...storedCapture } = capture("test")
    const capWire = {
      ...storedCapture, id: "1", updatedAt: base.start, attentionMinutes: [["2026-09-16", 720]],
    }
    for (const bad of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z", base.end]) {
      expect(() => decodeExact(BootstrapSessionV1Schema, { ...wire, start: bad, end: base.start })).toThrow()
      expect(() => decodeExact(BootstrapCaptureV1Schema, { ...capWire, startedAt: bad, endedAt: base.start })).toThrow()
    }
  })
})

describe("ingestion and persistent recovery", () => {
  test("rejects mixed poison batches before modifying any state, including direct callers", async () => {
    const db = open()
    const app = createApp({ db, now: () => now })
    await Effect.runPromise(ingestCaptures(db, captures([capture("existing")]), now))
    await Effect.runPromise(ingestSessions(db, sessions([session("existing")]), now))
    const before = snapshot(db)
    for (const badMinute of [Number.MAX_SAFE_INTEGER, MAX_UTC_MINUTE + 1, minute - 1]) {
      const capBatch = captures([capture("new"), { ...capture("existing"), attentionMinutes: [badMinute] }])
      const sessionBatch = sessions([session("new"), { ...session("existing"), activity: [[badMinute, 2, 1]] }])
      expect((await post(app, "/api/captures", capBatch)).status).toBe(400)
      expect((await post(app, "/api/ingest", sessionBatch)).status).toBe(400)
      await expect(Effect.runPromise(ingestCaptures(db, capBatch, now + 1000))).rejects.toThrow()
      await expect(Effect.runPromise(ingestSessions(db, sessionBatch, now + 1000))).rejects.toThrow()
      expect(snapshot(db)).toEqual(before)
      expect((await app(new Request("http://trails.test/api/bootstrap"))).status).toBe(200)
    }
  })

  async function legacyPoison() {
    const root = mkdtempSync(join(tmpdir(), "trails-timestamp-test-"))
    roots.push(root)
    const path = join(root, "trails.sqlite")
    // Construct the actual v6 schema, before the recovery tables exist.
    const sqlite = new Database(path)
    sqlite.exec("PRAGMA foreign_keys=ON")
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 6)) {
      sqlite.exec(migration.sql)
      migration.afterSql?.(sqlite, { defaultTimezone: "UTC", now })
    }
    sqlite.exec("PRAGMA user_version=6")
    const db: TrailsDb = { sqlite, path, close: () => sqlite.close() }
    databases.push(db)
    await Effect.runPromise(ingestSessions(db, sessions([session("good"), session("bad")]), now))
    await Effect.runPromise(ingestCaptures(db, captures([capture("good"), capture("bad")]), now))
    sqlite.exec(`
      UPDATE session_activity SET utc_minute = 9007199254740991 WHERE session_id = 2;
      UPDATE captures SET started_at = '+010000-01-01T00:00:00.000Z' WHERE id = 2;
      UPDATE capture_attention SET utc_minute = 9007199254740991 WHERE capture_id = 2;
      INSERT INTO capture_images VALUES (2, 0, 'image/png', 1, 1, x'010203', 'test-hash');
      INSERT INTO session_summaries VALUES (2, 'digest', 'test', 'Preserve this summary', ${now});
      INSERT INTO day_summaries VALUES ('2026-09-16', 'work/test', 6, 'test', 'Stale summary', ${now});
    `)
    return db
  }

  test("quarantines poisoned rows and children, restores bootstrap, and only migrates once", async () => {
    const legacy = await legacyPoison()
    const path = legacy.path
    const rows = Object.fromEntries([
      ["sessions", "id"], ["session_activity", "session_id"], ["session_summaries", "session_id"],
      ["session_summary_jobs", "session_id"], ["captures", "id"], ["capture_attention", "capture_id"],
      ["capture_images", "capture_id"],
    ].map(([table, key]) => [table, legacy.sqlite.query(`SELECT * FROM ${table} WHERE ${key} = 2`).all()]))
    expect(() => bootstrapOf(legacy, now)).toThrow()
    close(legacy)
    const db = open(path)
    for (const [table, archived] of Object.entries(rows)) {
      expect(db.sqlite.query(`SELECT * FROM timestamp_quarantine_${table}`).all()).toEqual(archived)
    }
    expect(db.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 7 })
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    const restored = bootstrapOf(db, now)
    expect(restored.sessions).toHaveLength(1)
    expect(restored.captures).toHaveLength(1)
    expect(restored.summaries.days).toEqual({})
    expect(restored.revision).toBe(3)
    expect(db.sqlite.query("SELECT count(*) AS n FROM day_summary_jobs").get()).toEqual({ n: 1 })
    close(db)
    const reopened = open(path)
    expect(bootstrapOf(reopened, now)).toEqual(restored)
    expect(reopened.sqlite.query("SELECT count(*) AS n FROM timestamp_quarantine_captures").get()).toEqual({ n: 1 })
    // Corrected re-ingestion is possible without touching the archived copy.
    await Effect.runPromise(ingestCaptures(reopened, captures([capture("bad")]), now))
    expect(bootstrapOf(reopened, now).captures).toHaveLength(2)
  })

  test("recovery also catches timestamp and interval violations with otherwise valid minutes", async () => {
    for (const [start, end, utcMinute] of [
      ["-000001-01-01T00:00:00.000Z", new Date(now).toISOString(), minute],
      ["+010000-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", minute],
      ["9999-12-31T00:00:00.000Z", "9999-12-31T00:00:00.000Z", MAX_UTC_MINUTE],
      [new Date(now + 60_000).toISOString(), new Date(now).toISOString(), minute],
      [new Date(now).toISOString(), new Date(now).toISOString(), minute + 1],
    ] as const) {
      const legacy = await legacyPoison()
      legacy.sqlite.query("UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = 2").run(start, end)
      legacy.sqlite.query("UPDATE captures SET started_at = ?, ended_at = ? WHERE id = 2").run(start, end)
      legacy.sqlite.query("UPDATE session_activity SET utc_minute = ? WHERE session_id = 2").run(utcMinute)
      legacy.sqlite.query("UPDATE capture_attention SET utc_minute = ? WHERE capture_id = 2").run(utcMinute)
      const path = legacy.path
      close(legacy)
      const recovered = open(path)
      expect(bootstrapOf(recovered, now).sessions).toHaveLength(1)
      expect(bootstrapOf(recovered, now).captures).toHaveLength(1)
      expect(recovered.sqlite.query("SELECT started_at FROM timestamp_quarantine_sessions").get()).toEqual({ started_at: start })
      expect(recovered.sqlite.query("SELECT ended_at FROM timestamp_quarantine_captures").get()).toEqual({ ended_at: end })
    }
  })

  test("a recovery failure rolls back archives, deletions, revision and schema version", async () => {
    const legacy = await legacyPoison()
    const path = legacy.path
    const before = snapshot(legacy)
    legacy.sqlite.exec(`CREATE TRIGGER fail_recovery BEFORE DELETE ON captures
      BEGIN SELECT RAISE(ABORT, 'injected recovery failure'); END`)
    close(legacy)
    expect(() => openDatabase(path)).toThrow("injected recovery failure")
    const sqlite = new Database(path)
    const failed: TrailsDb = { sqlite, path, close: () => sqlite.close() }
    databases.push(failed)
    expect(snapshot(failed)).toEqual(before)
    expect(sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 6 })
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'timestamp_quarantine_%'").all()).toEqual([])
    expect(sqlite.query("SELECT summary FROM day_summaries").get()).toEqual({ summary: "Stale summary" })
    sqlite.exec("DROP TRIGGER fail_recovery")
    close(failed)
    expect(bootstrapOf(open(path), now).captures).toHaveLength(1)
  })
})
