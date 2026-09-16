import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApp, setAdvertisedHubUrl } from "./authenticated-app"
import { ingestCaptures } from "../server/captures"
import { openDatabase, type TrailsDb } from "../server/db"
import { sessionContentHash } from "../server/ingest"
import { MIGRATIONS } from "../server/migrations"
import { DAY_SYSTEM, SESSION_SYSTEM } from "../shared/prompts"
import type {
  BootstrapV1,
  IngestCaptureV1,
  IngestCapturesRequestV1,
  IngestRequestV2,
  IngestSessionV2,
  MidjourneyCaptureV1,
} from "../shared/protocol"

const roots = new Set<string>()
const databases = new Set<TrailsDb>()

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trails-server-test-"))
  roots.add(root)
  return root
}

function trackedDatabase(path: string) {
  const database = openDatabase(path, { defaultTimezone: "America/Los_Angeles" })
  databases.add(database)
  return database
}
const LEGACY_PROJECT = "code/acme/fallback"
const LEGACY_START = "2026-11-01T09:30:30.000Z"
const LEGACY_END = "2026-11-01T09:31:00.000Z"
const LEGACY_UPDATED_AT = Date.parse("2026-11-01T09:32:00.000Z")

function createMigration3Fixture(path: string): void {
  const legacy = new Database(path, { create: true, strict: true })
  for (const migration of MIGRATIONS.slice(0, 3)) legacy.exec(migration.sql)
  legacy.exec("PRAGMA user_version = 3")
  legacy
    .query("INSERT INTO machines(id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .run("legacy-mac", "Legacy Mac", LEGACY_UPDATED_AT - 1_000, LEGACY_UPDATED_AT)
  const inserted = legacy
    .query(
      `INSERT INTO sessions(machine_id, source, source_session_id, cwd, project, branch, started_at,
         ended_at, event_count, user_event_count, first_prompt, digest, digest_hash, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(
      "legacy-mac",
      "omp",
      "fallback",
      `/Users/tester/${LEGACY_PROJECT}`,
      LEGACY_PROJECT,
      "feat/fallback",
      LEGACY_START,
      LEGACY_END,
      2,
      1,
      "Repeated hour",
      null,
      null,
      "legacy-content",
      LEGACY_UPDATED_AT,
    ) as { id: number }
  legacy
    .query(
      `INSERT INTO session_activity(session_id, local_date, minute, event_count, user_event_count)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(inserted.id, "2026-11-01", 90, 2, 1)
  legacy
    .query(
      `INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("2026-10-31", LEGACY_PROJECT, 6, "legacy", "Legacy day", LEGACY_UPDATED_AT)
  legacy
    .query(
      `INSERT INTO day_summary_jobs(work_date, project, boundary, generation, attempts, available_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("2026-10-31", LEGACY_PROJECT, 6, 7, 2, LEGACY_UPDATED_AT, "LegacyError")
  legacy.query("UPDATE meta SET value = '11' WHERE key = 'state_revision'").run()
  legacy.close()
}

function closeDatabase(database: TrailsDb): void {
  if (!databases.delete(database)) return
  database.close()
}

afterEach(async () => {
  for (const database of databases) {
    try {
      database.close()
    } catch {
      // A failed assertion may leave a database that was already closed.
    }
  }
  databases.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function session(
  sourceSessionId: string,
  overrides: Partial<IngestSessionV2> = {},
): IngestSessionV2 {
  return {
    sourceSessionId,
    source: "omp",
    cwd: "/Users/tester/code/acme/trails",
    branch: "feat/hub",
    start: "2026-08-03T16:00:00.000Z",
    end: "2026-08-03T16:02:00.000Z",
    events: 2,
    userEvents: 1,
    firstPrompt: "Build the hub",
    activity: [[Math.floor(Date.parse("2026-08-03T16:00:00.000Z") / 60_000), 2, 1]],
    digest: "A bounded private digest",
    ...overrides,
  }
}

function ingestBody(
  sessions: ReadonlyArray<IngestSessionV2>,
  device = { id: "device-a", name: "Studio" },
): IngestRequestV2 {
  return { protocolVersion: 2, device, sessions }
}

const syntheticWebp = Buffer.from("RIFF\\x08\\x00\\x00\\x00WEBPsynthetic")

function capture(
  sourceRecordId: string,
  overrides: Partial<MidjourneyCaptureV1> = {},
): MidjourneyCaptureV1 {
  return {
    source: "midjourney",
    sourceRecordId,
    project: "/Users/tester/code/acme/ambient",
    projectHint: "Ideas",
    title: "Synthetic generation",
    startedAt: "2026-08-03T17:00:00.000Z",
    endedAt: null,
    summaryInput: "A bounded synthetic prompt",
    attentionMinutes: [Math.floor(Date.parse("2026-08-03T17:00:00.000Z") / 60_000)],
    payload: {
      eventType: "imagine",
      jobType: "generation",
      parentSourceRecordId: null,
      parentGrid: null,
    },
    images: Array.from({ length: 4 }, (_, index) => ({
      index,
      mime: "image/webp" as const,
      width: 640,
      height: 640,
      bytes: syntheticWebp.toString("base64"),
    })),
    ...overrides,
  }
}

function captureBody(
  captures: ReadonlyArray<IngestCaptureV1>,
  device = { id: "device-a", name: "Studio" },
): IngestCapturesRequestV1 {
  return { protocolVersion: 1, device, captures }
}

type App = (request: Request) => Promise<Response>

function request(app: App, method: string, path: string, body?: unknown): Promise<Response> {
  return app(
    new Request(`http://trails.test${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
}

function json(response: Response): Promise<Record<string, unknown>>
function json<T>(response: Response): Promise<T>
async function json<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>
}

describe("database opening and ordered migrations", () => {
  test("applies every migration once and configures a private WAL database", async () => {
    const root = await temporaryRoot()
    const path = join(root, "nested", "trails.sqlite")
    const database = trackedDatabase(path)

    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(new Set(MIGRATIONS.map(({ version }) => version)).size).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.every((migration, index) => index === 0 || MIGRATIONS[index - 1]!.version < migration.version)).toBe(true)
    expect(database.path).toBe(resolve(path))
    const userVersion = database.sqlite.query("PRAGMA user_version").get() as { user_version: number }
    const journalMode = database.sqlite.query("PRAGMA journal_mode").get() as { journal_mode: string }
    const foreignKeys = database.sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    const busyTimeout = database.sqlite.query("PRAGMA busy_timeout").get() as Record<string, number>
    expect(userVersion.user_version).toBe(8)
    expect(journalMode.journal_mode).toBe("wal")
    expect(foreignKeys.foreign_keys).toBe(1)
    expect(Object.values(busyTimeout)[0]).toBe(100)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "0" })
    expect(
      database.sqlite.query("SELECT boundary, halo, onboarding_version, hub_url FROM settings WHERE id = 1").get(),
    ).toEqual({
      boundary: 6,
      halo: 10,
      onboarding_version: 0,
      hub_url: "http://127.0.0.1:7412/",
    })

    const tableNames = (database.sqlite
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>).map(({ name }) => name)
    expect(tableNames).toEqual(
      expect.arrayContaining([
        "meta",
        "machines",
        "sessions",
        "session_activity",
        "settings",
        "custom_engagements",
        "project_preferences",
        "pocket_items",
        "session_summaries",
        "day_summaries",
        "session_summary_jobs",
        "day_summary_jobs",
        "captures",
        "capture_attention",
        "capture_images",
      ]),
    )
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700)

    database.sqlite.query("UPDATE settings SET halo = 15 WHERE id = 1").run()
    closeDatabase(database)
    const reopened = trackedDatabase(path)
    const reopenedVersion = reopened.sqlite.query("PRAGMA user_version").get() as { user_version: number }
    expect(reopenedVersion.user_version).toBe(8)
    expect(
      reopened.sqlite
        .query("SELECT boundary, halo, onboarding_version, hub_url, timezone FROM settings WHERE id = 1")
        .get(),
    ).toEqual({
      boundary: 6,
      halo: 15,
      onboarding_version: 0,
      hub_url: "http://127.0.0.1:7412/",
      timezone: "America/Los_Angeles",
    })
  })
  test("migrates Pacific activity to UTC, adopts Rome, and makes collector replay idempotent", async () => {
    const root = await temporaryRoot()
    const path = join(root, "rome.sqlite")
    createMigration3Fixture(path)
    const migrationNow = Date.parse("2026-11-01T10:00:00.000Z")
    const database = openDatabase(path, { defaultTimezone: "Europe/Rome", now: migrationNow })
    databases.add(database)

    expect(database.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 8 })
    expect(database.sqlite.query("SELECT timezone FROM settings WHERE id = 1").get()).toEqual({
      timezone: "Europe/Rome",
    })
    const repeatedMinute = Math.floor(Date.parse("2026-11-01T09:30:00.000Z") / 60_000)
    expect(
      database.sqlite
        .query("SELECT utc_minute, event_count, user_event_count FROM session_activity")
        .all(),
    ).toEqual([{ utc_minute: repeatedMinute, event_count: 2, user_event_count: 1 }])
    expect(database.sqlite.query("SELECT work_date FROM day_summaries").all()).toEqual([])
    expect(
      database.sqlite
        .query("SELECT work_date, project, boundary, generation, available_at FROM day_summary_jobs")
        .all(),
    ).toEqual([
      {
        work_date: "2026-11-01",
        project: LEGACY_PROJECT,
        boundary: 6,
        generation: 8,
        available_at: migrationNow,
      },
    ])
    expect(database.sqlite.query("SELECT updated_at FROM sessions").get()).toEqual({
      updated_at: LEGACY_UPDATED_AT,
    })
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "11",
    })

    const migratedSession: IngestSessionV2 = {
      sourceSessionId: "fallback",
      source: "omp",
      cwd: `/Users/tester/${LEGACY_PROJECT}`,
      branch: "feat/fallback",
      start: LEGACY_START,
      end: LEGACY_END,
      events: 2,
      userEvents: 1,
      firstPrompt: "Repeated hour",
      activity: [[repeatedMinute, 2, 1]],
      digest: null,
    }
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => migrationNow + 1_000 })
    let response = await request(
      app,
      "POST",
      "/api/ingest",
      ingestBody([migratedSession], { id: "legacy-mac", name: "Legacy Mac" }),
    )
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 11 })
    expect(database.sqlite.query("SELECT updated_at FROM sessions").get()).toEqual({
      updated_at: LEGACY_UPDATED_AT,
    })
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM day_summary_jobs").get()).toEqual({
      count: 1,
    })

    response = await request(
      app,
      "POST",
      "/api/ingest",
      ingestBody(
        [
          {
            ...migratedSession,
            activity: [
              [Math.floor(Date.parse("2026-11-01T08:30:00.000Z") / 60_000), 1, 1],
              [repeatedMinute, 1, 0],
            ],
          },
        ],
        { id: "legacy-mac", name: "Legacy Mac" },
      ),
    )
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 12 })
    expect(
      database.sqlite.query("SELECT utc_minute FROM session_activity ORDER BY utc_minute").all(),
    ).toEqual([
      { utc_minute: Math.floor(Date.parse("2026-11-01T08:30:00.000Z") / 60_000) },
      { utc_minute: repeatedMinute },
    ])

    closeDatabase(database)
    const reopened = openDatabase(path, { defaultTimezone: "UTC", now: migrationNow + 2_000 })
    databases.add(reopened)
    expect(reopened.sqlite.query("SELECT timezone FROM settings WHERE id = 1").get()).toEqual({
      timezone: "Europe/Rome",
    })
    expect(reopened.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "12",
    })
  })

  test("retains valid Pacific day summaries and generations during migration", async () => {
    const root = await temporaryRoot()
    const path = join(root, "los-angeles.sqlite")
    createMigration3Fixture(path)
    const database = openDatabase(path, {
      defaultTimezone: "America/Los_Angeles",
      now: Date.parse("2026-11-01T10:00:00.000Z"),
    })
    databases.add(database)

    expect(database.sqlite.query("SELECT work_date, summary FROM day_summaries").all()).toEqual([
      { work_date: "2026-10-31", summary: "Legacy day" },
    ])
    expect(
      database.sqlite.query("SELECT work_date, generation, attempts, last_error FROM day_summary_jobs").all(),
    ).toEqual([
      { work_date: "2026-10-31", generation: 7, attempts: 2, last_error: "LegacyError" },
    ])
  })


  test("migrates a version-three database without disturbing canonical state", async () => {
    const root = await temporaryRoot()
    const path = join(root, "trails.sqlite")
    createMigration3Fixture(path)
    const legacy = new Database(path, { strict: true })
    legacy.query("UPDATE settings SET halo = 15 WHERE id = 1").run()
    legacy.close()

    const migrated = trackedDatabase(path)
    expect(migrated.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 8 })
    expect(migrated.sqlite.query("SELECT halo FROM settings WHERE id = 1").get()).toEqual({ halo: 15 })
    expect(migrated.sqlite.query("SELECT count(*) AS count FROM captures").get()).toEqual({ count: 0 })
    expect(migrated.sqlite.query("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 1 })
    expect(migrated.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "11" })
  })
})

describe("advertised hub URL", () => {
  test("publishes the setup URL and revisions only visible changes", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    const url = "https://trails.example.ts.net/"

    expect(setAdvertisedHubUrl(database, url)).toBe(1)
    expect(setAdvertisedHubUrl(database, url)).toBe(1)
    const response = await request(app, "GET", "/api/bootstrap")
    expect(response.status).toBe(200)
    expect(await json<BootstrapV1>(response)).toMatchObject({ revision: 1, hubUrl: url })
  })
})

describe("collector status and machine topology", () => {
  test("tracks receipt freshness, nullable metrics, errors, sorting, and visible name revisions", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "machines.sqlite"))
    let now = Date.parse("2026-08-04T10:00:00.000Z")
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => now })
    const metrics = { discovered: 2, changed: 1, uploaded: 1, ignored: 0, unchanged: 1 }
    const status = (
      device: { id: string; name: string },
      outcome: Record<string, unknown>,
    ) => request(app, "POST", "/api/collector-status", { protocolVersion: 1, device, outcome })

    let response = await status(
      { id: "spoke-b", name: "beta" },
      { status: "processed", metrics, error: null },
    )
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    expect(
      await json(await request(app, "GET", "/api/machines")),
    ).toEqual({
      protocolVersion: 1,
      generatedAt: new Date(now).toISOString(),
      machines: [
        {
          id: "spoke-b",
          name: "beta",
          firstSeenAt: new Date(now).toISOString(),
          lastIngestedAt: null,
          lastCheckedAt: new Date(now).toISOString(),
          lastProcessedAt: new Date(now).toISOString(),
          lastError: null,
          metrics,
        },
      ],
    })
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "0",
    })

    now += 1_000
    response = await request(
      app,
      "POST",
      "/api/ingest",
      ingestBody([session("machine-session")], { id: "spoke-b", name: "beta" }),
    )
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 1 })

    const processedAt = Date.parse("2026-08-04T10:00:00.000Z")
    now += 1_000
    await status(
      { id: "spoke-b", name: "beta" },
      {
        status: "failed",
        metrics: { discovered: 3, changed: 2, uploaded: 0, ignored: 1, unchanged: 1 },
        error: "parse_error",
      },
    )
    let machines = (await json<{ machines: Array<Record<string, unknown>> }>(
      await request(app, "GET", "/api/machines"),
    )).machines
    expect(machines[0]).toMatchObject({
      lastIngestedAt: new Date(now - 1_000).toISOString(),
      lastCheckedAt: new Date(now).toISOString(),
      lastProcessedAt: new Date(processedAt).toISOString(),
      lastError: "parse_error",
      metrics: { discovered: 3, changed: 2, uploaded: 0, ignored: 1, unchanged: 1 },
    })

    now += 1_000
    await status(
      { id: "spoke-b", name: "beta" },
      { status: "failed", metrics: null, error: "collector_error" },
    )
    machines = (await json<{ machines: Array<Record<string, unknown>> }>(
      await request(app, "GET", "/api/machines"),
    )).machines
    expect(machines[0]).toMatchObject({
      lastProcessedAt: new Date(processedAt).toISOString(),
      lastError: "collector_error",
      metrics: null,
    })

    now += 1_000
    await status(
      { id: "spoke-b", name: "Alpha" },
      { status: "processed", metrics: { ...metrics, changed: 0, uploaded: 0 }, error: null },
    )
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "2",
    })
    await status(
      { id: "spoke-z", name: "alpha" },
      { status: "failed", metrics: null, error: "upload_error" },
    )
    await status(
      { id: "spoke-a", name: "alpha" },
      { status: "failed", metrics: null, error: "upload_error" },
    )
    await status(
      { id: "spoke-z", name: "Zulu" },
      { status: "failed", metrics: null, error: "upload_error" },
    )
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "2",
    })
    machines = (await json<{ machines: Array<Record<string, unknown>> }>(
      await request(app, "GET", "/api/machines"),
    )).machines
    expect(machines.map((machine) => [machine.name, machine.id])).toEqual([
      ["alpha", "spoke-a"],
      ["Alpha", "spoke-b"],
      ["Zulu", "spoke-z"],
    ])
    expect(machines.every((machine) => !("online" in machine))).toBe(true)
  })
})

describe("summarization status", () => {
  test("returns disabled and locally described states without network calls", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "summarization.sqlite"))
    const disabled = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    expect(await json(await request(disabled, "GET", "/api/summarization"))).toEqual({
      enabled: false,
      metadata: null,
    })

    const enabled = createApp({ trustedOrigins: ["http://trails.test"],
      db: database,
      summarization: { describe: () => ({ selection: "auto", harness: "codex" }) },
    })
    expect(await json(await request(enabled, "GET", "/api/summarization"))).toEqual({
      enabled: true,
      metadata: {
        protocolVersion: 2,
        harness: "codex",
        prompts: { session: SESSION_SYSTEM, day: DAY_SYSTEM },
      },
    })

    const off = createApp({ trustedOrigins: ["http://trails.test"], db: database, summarization: { describe: () => null } })
    expect(await json(await request(off, "GET", "/api/summarization"))).toEqual({
      enabled: false,
      metadata: null,
    })

    const unavailable = createApp({ trustedOrigins: ["http://trails.test"],
      db: database,
      summarization: { describe: () => ({ selection: "omp", harness: null }) },
    })
    expect(await json(await request(unavailable, "GET", "/api/summarization"))).toEqual({
      enabled: false,
      metadata: null,
    })
  })
})

describe("ingest and bootstrap", () => {
  test("upserts by machine/source/session, replaces activity, and revisions only visible changes", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    const original = session("hidden-source-session", { digest: "PRIVATE TRANSCRIPT DIGEST" })

    let response = await request(app, "POST", "/api/ingest", ingestBody([original]))
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 1 })

    response = await request(app, "POST", "/api/ingest", ingestBody([original]))
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 1 })

    response = await request(app, "POST", "/api/ingest", ingestBody([original], { id: "device-a", name: "Studio Renamed" }))
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 2 })

    response = await request(app, "POST", "/api/ingest", ingestBody([original], { id: "device-a", name: "Studio Renamed" }))
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 2 })

    const changed = session("hidden-source-session", {
      end: "2026-08-03T16:04:00.000Z",
      events: 4,
      userEvents: 2,
      activity: [
        [Math.floor(Date.parse("2026-08-03T16:00:00.000Z") / 60_000), 1, 1],
        [Math.floor(Date.parse("2026-08-03T16:02:00.000Z") / 60_000), 3, 1],
      ],
      digest: "NEW PRIVATE TRANSCRIPT DIGEST",
    })
    response = await request(app, "POST", "/api/ingest", ingestBody([changed], { id: "device-a", name: "Studio Renamed" }))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 3 })

    const stored = database.sqlite
      .query("SELECT id, machine_id, source_session_id, content_hash, event_count FROM sessions")
      .get() as { id: number; machine_id: string; source_session_id: string; content_hash: string; event_count: number }
    expect(stored).toMatchObject({ machine_id: "device-a", source_session_id: "hidden-source-session", event_count: 4 })
    expect(stored.content_hash).toBe(sessionContentHash(changed))
    expect(database.sqlite
      .query("SELECT utc_minute, event_count, user_event_count FROM session_activity ORDER BY utc_minute")
      .all()).toEqual([
      {
        utc_minute: Math.floor(Date.parse("2026-08-03T16:00:00.000Z") / 60_000),
        event_count: 1,
        user_event_count: 1,
      },
      {
        utc_minute: Math.floor(Date.parse("2026-08-03T16:02:00.000Z") / 60_000),
        event_count: 3,
        user_event_count: 1,
      },
    ])

    response = await request(app, "POST", "/api/ingest", ingestBody([changed], { id: "device-b", name: "Laptop" }))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 4 })

    response = await request(app, "GET", "/api/bootstrap")
    expect(response.status).toBe(200)
    const bootstrap = await json<BootstrapV1>(response)
    expect(bootstrap.protocolVersion).toBe(1)
    expect(bootstrap.revision).toBe(4)
    expect(bootstrap.hubUrl).toBe("http://127.0.0.1:7412/")
    expect(bootstrap.timezone).toBe("America/Los_Angeles")
    expect(bootstrap.sessions).toHaveLength(2)
    expect(bootstrap.sessions.map((entry: { id: string }) => entry.id)).toEqual([String(stored.id), String(stored.id + 1)])
    expect(bootstrap.sessions.map((entry: { machine: { id: string; name: string } }) => entry.machine)).toEqual([
      { id: "device-a", name: "Studio Renamed" },
      { id: "device-b", name: "Laptop" },
    ])
    expect(Object.keys(bootstrap.sessions[0]).sort()).toEqual([
      "activity",
      "branch",
      "cwd",
      "end",
      "events",
      "firstPrompt",
      "id",
      "machine",
      "source",
      "start",
      "userEvents",
    ])
    const encoded = JSON.stringify(bootstrap)
    expect(encoded).not.toContain("hidden-source-session")
    expect(encoded).not.toContain("PRIVATE TRANSCRIPT DIGEST")
    expect(encoded).not.toContain("sourceSessionId")
    expect(encoded).not.toContain("digest")
    expect(encoded).not.toContain("sourcePath")
    expect(bootstrap.preferences).toEqual({
      boundary: 6,
      halo: 10,
      onboardingVersion: 0,
      assignments: {},
      customEngagements: [],
      names: {},
      pocket: [],
    })
  })

  test("accepts the 50-session boundary and rejects 51 before changing the database", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    const legacy = { ...ingestBody([session("legacy")]), protocolVersion: 1 }
    let response = await request(app, "POST", "/api/ingest", legacy)
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      error: { code: "unsupported_protocol", message: "unsupported protocol version" },
    })
    expect(database.sqlite.query("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 })

    const fifty = Array.from({ length: 50 }, (_, index) => session(`session-${index}`))

    response = await request(app, "POST", "/api/ingest", ingestBody(fifty))
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ accepted: 50, unchanged: 0, revision: 1 })
    const countAtLimit = database.sqlite.query("SELECT count(*) AS count FROM sessions").get() as { count: number }
    expect(countAtLimit.count).toBe(50)

    const fiftyOne = Array.from({ length: 51 }, (_, index) => session(`too-many-${index}`))
    response = await request(app, "POST", "/api/ingest", ingestBody(fiftyOne))
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      error: { code: "invalid_request", message: "request body failed validation" },
    })
    const countAfterRejection = database.sqlite.query("SELECT count(*) AS count FROM sessions").get() as { count: number }
    expect(countAfterRejection.count).toBe(50)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "1" })
  })

  test("rolls back the whole HTTP batch when a later upsert fails", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    database.sqlite.exec(`
      CREATE TRIGGER fail_selected_session BEFORE INSERT ON sessions
      WHEN NEW.source_session_id = 'force-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'forced test failure');
      END;
    `)

    const response = await request(
      app,
      "POST",
      "/api/ingest",
      ingestBody([session("would-have-succeeded"), session("force-rollback")]),
    )
    expect(response.status).toBe(500)
    expect(await json(response)).toEqual({
      error: { code: "internal_error", message: "internal server error" },
    })
    const machineCount = database.sqlite.query("SELECT count(*) AS count FROM machines").get() as { count: number }
    const sessionCount = database.sqlite.query("SELECT count(*) AS count FROM sessions").get() as { count: number }
    const activityCount = database.sqlite.query("SELECT count(*) AS count FROM session_activity").get() as { count: number }
    expect(machineCount.count).toBe(0)
    expect(sessionCount.count).toBe(0)
    expect(activityCount.count).toBe(0)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "0" })
  })
})

describe("capture ingest, bootstrap privacy, and image API", () => {
  test("is idempotent, preserves null reconciliation attribution, and replaces children atomically", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => Date.parse("2026-08-03T18:00:00.000Z") })
    const original = capture("job-private")

    let response = await request(app, "POST", "/api/captures", captureBody([original]))
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 1 })

    response = await request(app, "POST", "/api/captures", captureBody([original]))
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 1 })

    const reconciliation = { ...original, project: null }
    response = await request(app, "POST", "/api/captures", captureBody([reconciliation]))
    expect(await json(response)).toEqual({ accepted: 0, unchanged: 1, revision: 1 })

    const updated = { ...reconciliation, summaryInput: "A revised bounded synthetic prompt" }
    response = await request(app, "POST", "/api/captures", captureBody([updated]))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 2 })
    expect(database.sqlite.query("SELECT project FROM captures").get()).toEqual({ project: "code/acme/ambient" })
    expect(database.sqlite.query("SELECT count(*) AS count FROM capture_attention").get()).toEqual({ count: 1 })
    expect(database.sqlite.query("SELECT count(*) AS count FROM capture_images").get()).toEqual({ count: 4 })
    expect(database.sqlite.query("SELECT count(*) AS count FROM day_summary_jobs").get()).toEqual({ count: 0 })
    expect(database.sqlite.query("SELECT count(*) AS count FROM session_summary_jobs").get()).toEqual({ count: 0 })

    const reassigned = { ...updated, project: "/Users/tester/code/acme/reassigned" }
    response = await request(app, "POST", "/api/captures", captureBody([reassigned]))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 3 })
    expect(database.sqlite.query("SELECT project FROM captures").get()).toEqual({ project: "code/acme/reassigned" })
  })

  test("rolls back the full request when one child insert fails", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const valid = capture("job-valid")
    const duplicateImages = capture("job-invalid").images.map((image) => ({ ...image, index: 0 }))
    const invalid = capture("job-invalid", { images: duplicateImages })

    await expect(Effect.runPromise(ingestCaptures(database, captureBody([valid, invalid])))).rejects.toThrow(
      "capture ingestion failed",
    )
    expect(database.sqlite.query("SELECT count(*) AS count FROM captures").get()).toEqual({ count: 0 })
    expect(database.sqlite.query("SELECT count(*) AS count FROM machines").get()).toEqual({ count: 0 })
  })

  test("omits provider identifiers and serves persisted images with private validators", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const now = Date.parse("2026-08-03T18:00:00.000Z")
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => now })
    const parent = capture("job-private")
    const child = capture("variation-private", {
      startedAt: "2026-08-03T17:01:00.000Z",
      attentionMinutes: [Math.floor(Date.parse("2026-08-03T17:01:00.000Z") / 60_000)],
      payload: {
        eventType: "variation",
        jobType: "variation",
        parentSourceRecordId: "job-private",
        parentGrid: 2,
      },
    })
    expect((await request(app, "POST", "/api/captures", captureBody([parent, child]))).status).toBe(200)

    const bootstrapResponse = await request(app, "GET", "/api/bootstrap")
    const bootstrap = await json<BootstrapV1>(bootstrapResponse)
    expect(bootstrap.sessions).toEqual([])
    expect(bootstrap.captures).toHaveLength(2)
    expect(bootstrap.indexedAt).toBe("2026-08-03T18:00:00.000Z")
    const serialized = JSON.stringify(bootstrap)
    expect(serialized).not.toContain("job-private")
    expect(serialized).not.toContain("variation-private")
    expect(serialized).not.toContain("device-a")
    expect(serialized).not.toContain(syntheticWebp.toString("base64"))
    const childBootstrap = bootstrap.captures.find((item) => item.source === "midjourney" && item.payload.hasParent)
    expect(childBootstrap?.source).toBe("midjourney")
    if (!childBootstrap || childBootstrap.source !== "midjourney") throw new Error("missing child capture")
    expect(childBootstrap.payload.parentCaptureId).toBe(bootstrap.captures[0]?.id)
    expect(childBootstrap.payload).not.toHaveProperty("parentSourceRecordId")
    expect(bootstrap.captures[0]?.images.map((image) => image.url)).toEqual([
      expect.stringMatching(/^\/api\/capture-images\/\d+\/0\?v=[0-9a-f]{64}$/),
      expect.stringMatching(/^\/api\/capture-images\/\d+\/1\?v=[0-9a-f]{64}$/),
      expect.stringMatching(/^\/api\/capture-images\/\d+\/2\?v=[0-9a-f]{64}$/),
      expect.stringMatching(/^\/api\/capture-images\/\d+\/3\?v=[0-9a-f]{64}$/),
    ])

    const imageUrl = bootstrap.captures[0]!.images[0]!.url
    let imageResponse = await request(app, "GET", imageUrl)
    expect(imageResponse.status).toBe(200)
    expect(imageResponse.headers.get("content-type")).toBe("image/webp")
    expect(imageResponse.headers.get("content-length")).toBe(String(syntheticWebp.byteLength))
    expect(imageResponse.headers.get("cache-control")).toBe("no-store")
    expect(Buffer.from(await imageResponse.arrayBuffer())).toEqual(syntheticWebp)
    const etag = imageResponse.headers.get("etag")
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/)

    imageResponse = await app(new Request(`http://trails.test${imageUrl}`, { headers: { "If-None-Match": etag! } }))
    expect(imageResponse.status).toBe(304)
    expect((await imageResponse.arrayBuffer()).byteLength).toBe(0)

    imageResponse = await request(app, "HEAD", imageUrl)
    expect(imageResponse.status).toBe(200)
    expect(imageResponse.headers.get("content-length")).toBe(String(syntheticWebp.byteLength))
    expect((await imageResponse.arrayBuffer()).byteLength).toBe(0)
    expect((await request(app, "GET", "/api/capture-images/999/0")).status).toBe(404)
    expect((await request(app, "GET", "/api/capture-images/not-an-id/0")).status).toBe(400)
    expect((await request(app, "POST", imageUrl)).status).toBe(405)
  })

  test("accepts project preferences for a capture-only project", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    await request(app, "POST", "/api/captures", captureBody([capture("job-project")]))

    const response = await request(app, "PUT", "/api/projects", {
      project: "code/acme/ambient",
      displayName: "Ambient",
    })
    expect(response.status).toBe(200)
    expect((await json<BootstrapV1>(await request(app, "GET", "/api/bootstrap"))).preferences.names).toEqual({
      "code/acme/ambient": "Ambient",
    })
  })

  test("rejects invalid and oversized capture requests without partial state", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    const invalid = { ...captureBody([capture("job-invalid")]), privateToken: "nope" }
    expect((await request(app, "POST", "/api/captures", invalid)).status).toBe(400)
    const oversized = new Request("http://trails.test/api/captures", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(5 * 1024 * 1024 + 1) },
      body: "{}",
    })
    expect((await app(oversized)).status).toBe(413)
    expect(database.sqlite.query("SELECT count(*) AS count FROM captures").get()).toEqual({ count: 0 })
  })
})

describe("state mutation API", () => {
  test("enforces mutation status, validation, field presence, and exact no-op revisions", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    let response = await request(app, "POST", "/api/ingest", ingestBody([session("seed")]))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 1 })

    response = await request(app, "PATCH", "/api/settings", {})
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ revision: 1 })
    response = await request(app, "PATCH", "/api/settings", { boundary: 6, halo: 10 })
    expect(await json(response)).toEqual({ revision: 1 })
    response = await request(app, "PATCH", "/api/settings", { halo: 15 })
    expect(await json(response)).toEqual({ revision: 2 })
    response = await request(app, "PATCH", "/api/settings", { halo: 15 })
    expect(await json(response)).toEqual({ revision: 2 })
    response = await request(app, "PATCH", "/api/settings", { boundary: 5 })
    expect(await json(response)).toEqual({ revision: 3 })

    response = await request(app, "POST", "/api/engagements", { name: "Field Notes" })
    expect(response.status).toBe(200)
    const createdEngagement = await json<{
      revision: number
      engagement: { id: string; name: string }
    }>(response)
    expect(createdEngagement.revision).toBe(4)
    expect(createdEngagement.engagement.name).toBe("Field Notes")
    expect(createdEngagement.engagement.id).toMatch(/^custom:/)

    response = await request(app, "POST", "/api/engagements", { name: "field notes" })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual(createdEngagement)

    response = await request(app, "PUT", "/api/projects", { project: "code/acme/missing", displayName: "Missing" })
    expect(response.status).toBe(404)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found")
    response = await request(app, "PUT", "/api/projects", { project: "code/acme/trails", engagementId: "custom:missing" })
    expect(response.status).toBe(404)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found")

    response = await request(app, "PUT", "/api/projects", {
      project: "code/acme/trails",
      engagementId: createdEngagement.engagement.id,
      displayName: " Trails Hub ",
    })
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ revision: 5 })
    response = await request(app, "PUT", "/api/projects", {
      project: "code/acme/trails",
      engagementId: createdEngagement.engagement.id,
      displayName: "Trails Hub",
    })
    expect(await json(response)).toEqual({ revision: 5 })

    response = await request(app, "PUT", "/api/projects", { project: "code/acme/trails", displayName: null })
    expect(await json(response)).toEqual({ revision: 6 })
    response = await request(app, "PUT", "/api/projects", { project: "code/acme/trails", engagementId: null })
    expect(await json(response)).toEqual({ revision: 7 })
    response = await request(app, "PUT", "/api/projects", {
      project: "code/acme/trails",
      engagementId: null,
      displayName: null,
    })
    expect(await json(response)).toEqual({ revision: 7 })

    response = await request(app, "PUT", "/api/projects", { project: "code/acme/trails", engagementId: "org:acme" })
    expect(await json(response)).toEqual({ revision: 8 })
    response = await request(app, "PUT", "/api/projects", { project: "code/acme/trails", engagementId: "elsewhere" })
    expect(await json(response)).toEqual({ revision: 9 })

    response = await request(app, "POST", "/api/pocket", { text: "Remember the backup" })
    expect(response.status).toBe(201)
    const createdPocket = await json<{
      revision: number
      item: { id: string; text: string; at: number }
    }>(response)
    expect(createdPocket).toMatchObject({ revision: 10, item: { text: "Remember the backup" } })
    expect(createdPocket.item.id).toBeString()
    expect(createdPocket.item.at).toBeNumber()

    response = await request(app, "POST", "/api/pocket", { text: "" })
    expect(response.status).toBe(400)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("invalid_request")
    response = await request(app, "DELETE", "/api/pocket/missing")
    expect(response.status).toBe(404)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("not_found")
    response = await request(app, "DELETE", `/api/pocket/${createdPocket.item.id}`)
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ revision: 11 })

    response = await request(app, "GET", "/api/bootstrap?after=11")
    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
    response = await request(app, "GET", "/api/bootstrap?after=not-a-revision")
    expect(response.status).toBe(400)
    expect(await json(response)).toEqual({
      error: { code: "invalid_request", message: "after must be a nonnegative integer" },
    })

    response = await request(app, "GET", "/api/bootstrap")
    const bootstrap = await json<BootstrapV1>(response)
    expect(bootstrap.revision).toBe(11)
    expect(bootstrap.preferences).toMatchObject({
      boundary: 5,
      halo: 15,
      assignments: { "code/acme/trails": "elsewhere" },
      names: {},
      pocket: [],
    })
    expect(bootstrap.preferences.customEngagements).toEqual([createdEngagement.engagement])
  })
  test("regroups workdays atomically when the persisted timezone changes", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "timezone.sqlite"))
    const now = Date.parse("2026-08-04T12:00:00.000Z")
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => now })
    const utcMinute = Math.floor(Date.parse("2026-08-04T08:00:00.000Z") / 60_000)
    const timed = session("timezone", {
      start: "2026-08-04T08:00:00.000Z",
      end: "2026-08-04T08:01:00.000Z",
      activity: [[utcMinute, 2, 1]],
    })
    let response = await request(app, "POST", "/api/ingest", ingestBody([timed]))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 1 })
    const sessionId = (
      database.sqlite.query("SELECT id FROM sessions WHERE source_session_id = 'timezone'").get() as {
        id: number
      }
    ).id
    database.sqlite
      .query(
        `INSERT INTO session_summaries(session_id, digest_hash, model, summary, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, "digest", "test", "Session stays", now)
    database.sqlite
      .query(
        `INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("2026-08-03", "code/acme/trails", 6, "test", "Pacific day", now)

    response = await request(app, "PATCH", "/api/settings", { timezone: "Europe/Rome" })
    expect(await json(response)).toEqual({ revision: 2 })
    const bootstrap = await json<BootstrapV1>(await request(app, "GET", "/api/bootstrap"))
    expect(bootstrap.timezone).toBe("Europe/Rome")
    expect(bootstrap.sessions[0].activity).toEqual([["2026-08-04", 600, 2, 1]])
    expect(bootstrap.summaries.days).toEqual({})
    expect(bootstrap.summaries.sessions[String(sessionId)]).toBe("Session stays")
    expect(
      database.sqlite.query("SELECT work_date, boundary FROM day_summary_jobs").all(),
    ).toEqual([{ work_date: "2026-08-04", boundary: 6 }])

    response = await request(app, "PATCH", "/api/settings", { timezone: "Europe/Rome" })
    expect(await json(response)).toEqual({ revision: 2 })
    response = await request(app, "PATCH", "/api/settings", { timezone: "Not/A_Zone" })
    expect(response.status).toBe(400)
    expect(database.sqlite.query("SELECT timezone FROM settings WHERE id = 1").get()).toEqual({
      timezone: "Europe/Rome",
    })
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({
      value: "2",
    })
  })
})

describe("static and method routing", () => {
  test("serves assets and SPA fallbacks without ever falling back API or unsafe paths", async () => {
    const root = await temporaryRoot()
    const staticRoot = join(root, "client")
    await mkdir(staticRoot, { recursive: true })
    await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Trails shell</title>")
    await writeFile(join(staticRoot, "app-12345678.js"), "console.log('asset')")
    await writeFile(join(staticRoot, "plain.css"), "body{}")
    await writeFile(join(root, "outside.txt"), "must not escape")
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, staticRoot })

    let response = await request(app, "GET", "/")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("Trails shell")

    response = await request(app, "GET", "/days/2026-08-03")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toContain("Trails shell")

    response = await request(app, "GET", "/app-12345678.js")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await response.text()).toBe("console.log('asset')")

    response = await request(app, "HEAD", "/plain.css")
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(response.headers.get("content-length")).toBe(String(new TextEncoder().encode("body{}").byteLength))
    expect(await response.text()).toBe("")

    response = await request(app, "GET", "/api/does-not-exist")
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(await json(response)).toEqual({ error: { code: "not_found", message: "API route not found" } })

    response = await request(app, "GET", "/%2e%2e%2Foutside.txt")
    expect(response.status).toBe(400)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("invalid_request")
    response = await request(app, "GET", "/unsafe%00path")
    expect(response.status).toBe(400)
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("invalid_request")

    response = await request(app, "POST", "/")
    expect(response.status).toBe(405)
    expect(await json(response)).toEqual({ error: { code: "method_not_allowed", message: "method not allowed" } })
    response = await request(app, "POST", "/api/health")
    expect(response.status).toBe(405)
    expect(await json(response)).toEqual({ error: { code: "method_not_allowed", message: "method not allowed" } })

    const apiOnly = createApp({ trustedOrigins: ["http://trails.test"], db: database })
    response = await request(apiOnly, "GET", "/anything")
    expect(response.status).toBe(404)
    expect(await json(response)).toEqual({ error: { code: "not_found", message: "static serving is disabled" } })
    response = await request(apiOnly, "GET", "/api/health")
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true })

    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("must not escape")
    expect(await readdir(staticRoot)).toEqual(expect.arrayContaining(["index.html", "app-12345678.js", "plain.css"]))
  })
})
