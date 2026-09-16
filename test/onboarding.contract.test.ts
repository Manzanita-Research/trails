import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "./authenticated-app"
import { openDatabase, type TrailsDb } from "../server/db"
import { MIGRATIONS } from "../server/migrations"
import { localParts, workdayOf } from "../shared/domain"
import type { BootstrapV1, IngestRequestV2 } from "../shared/protocol"
import { createBootstrapRequester } from "../src/lib/api"

type App = (request: Request) => Promise<Response>
const databases = new Set<TrailsDb>()
const roots = new Set<string>()

afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

function memoryDatabase(): TrailsDb {
  const database = openDatabase(":memory:")
  databases.add(database)
  return database
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trails-onboarding-test-"))
  roots.add(root)
  return root
}

function trackedDatabase(path: string): TrailsDb {
  const database = openDatabase(path, { defaultTimezone: "America/Los_Angeles" })
  databases.add(database)
  return database
}

function relativeRequest(app: App) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    app(new Request(new URL(String(input), "http://trails.test"), init))
}

function requireSnapshot(snapshot: BootstrapV1 | null): BootstrapV1 {
  if (snapshot === null) throw new Error("expected a loaded bootstrap snapshot")
  return snapshot
}

const ingest: IngestRequestV2 = {
  protocolVersion: 2,
  device: { id: "source-mac", name: "Source Mac" },
  sessions: [
    {
      sourceSessionId: "first-trail",
      source: "omp",
      cwd: "/Users/tester/code/acme/trails",
      branch: "feat/onboarding",
      start: "2026-07-01T12:29:00.000Z",
      end: "2026-07-01T12:30:00.000Z",
      events: 2,
      userEvents: 1,
      firstPrompt: "Make the first trail legible",
      activity: [[Math.floor(Date.parse("2026-07-01T12:29:00.000Z") / 60_000), 2, 1]],
      digest: null,
    },
  ],
}

describe("onboarding bootstrap contract", () => {
  test("indexes accepted session changes at deterministic application time", async () => {
    const fixedTimestamp = "2026-07-01T12:30:00.000Z"
    const fixedNow = Date.parse(fixedTimestamp)
    const database = memoryDatabase()
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => fixedNow })
    const request = relativeRequest(app)
    let snapshot: BootstrapV1 | null = null
    const requester = createBootstrapRequester({
      request,
      read: () => snapshot,
      write: (value) => {
        snapshot = value
      },
      setError: (error) => expect(error).toBeNull(),
      setLoading: () => {},
      isMounted: () => true,
    })

    await requester.fetch(false)
    expect(snapshot).toMatchObject({
      revision: 0,
      generatedAt: fixedTimestamp,
      indexedAt: null,
      sessions: [],
      preferences: { onboardingVersion: 0 },
    })

    const ingestResponse = await request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ingest),
    })
    expect(ingestResponse.status).toBe(200)

    await requester.fetch(true)
    expect(snapshot).toMatchObject({
      revision: 1,
      generatedAt: fixedTimestamp,
      indexedAt: fixedTimestamp,
    })
    const acceptedSnapshot = requireSnapshot(snapshot)
    expect(acceptedSnapshot.sessions).toHaveLength(1)
    await requester.fetch(true)
    expect(requireSnapshot(snapshot)).toBe(acceptedSnapshot)

    const settingsResponse = await request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boundary: 5 }),
    })
    expect(settingsResponse.status).toBe(200)
    expect(
      database.sqlite.query("SELECT boundary, available_at FROM day_summary_jobs WHERE boundary = 5").get(),
    ).toEqual({ boundary: 5, available_at: fixedNow })
  })

  test("persists canonical onboarding completion and keeps it across a 204 refresh", async () => {
    const database = memoryDatabase()
    const app = createApp({ trustedOrigins: ["http://trails.test"], db: database, now: () => Date.parse("2026-07-01T12:30:00.000Z") })
    const request = relativeRequest(app)
    let snapshot: BootstrapV1 | null = null
    const requester = createBootstrapRequester({
      request,
      read: () => snapshot,
      write: (value) => {
        snapshot = value
      },
      setError: (error) => expect(error).toBeNull(),
      setLoading: () => {},
      isMounted: () => true,
    })

    await requester.fetch(false)
    expect(requireSnapshot(snapshot).preferences.onboardingVersion).toBe(0)

    let response = await request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingVersion: 1 }),
    })
    expect(response.status).toBe(200)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "1" })

    await requester.fetch(true)
    const completed = requireSnapshot(snapshot)
    expect(completed.revision).toBe(1)
    expect(completed.preferences.onboardingVersion).toBe(1)

    response = await request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingVersion: 1 }),
    })
    expect(response.status).toBe(200)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "1" })

    await requester.fetch(true)
    expect(requireSnapshot(snapshot)).toBe(completed)
    expect(completed.preferences.onboardingVersion).toBe(1)
  })

  test("upgrades a version-one database without losing canonical state", async () => {
    const root = await temporaryRoot()
    const path = join(root, "trails.sqlite")
    await writeFile(path, "", { mode: 0o600, flag: "wx" })
    const legacy = new Database(path, { create: true })
    legacy.exec(MIGRATIONS[0]!.sql)
    legacy.query("UPDATE meta SET value = '7' WHERE key = 'state_revision'").run()
    legacy.query("UPDATE settings SET boundary = 7, halo = 15 WHERE id = 1").run()
    legacy
      .query("INSERT INTO machines(id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
      .run("legacy-mac", "Legacy Mac", 1, 2)
    legacy
      .query(
        `INSERT INTO sessions(machine_id, source, source_session_id, cwd, project, branch, started_at,
           ended_at, event_count, user_event_count, first_prompt, digest, digest_hash, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-mac",
        "omp",
        "legacy-session",
        "/Users/tester/code/acme/legacy",
        "/Users/tester/code/acme/legacy",
        "main",
        "2026-06-30T17:00:00.000Z",
        "2026-06-30T17:01:00.000Z",
        2,
        1,
        "Preserve me",
        null,
        null,
        "legacy-content",
        Date.parse("2026-06-30T17:01:00.000Z"),
      )
    legacy.exec("PRAGMA user_version = 1")
    legacy.close()

    const migrated = trackedDatabase(path)
    expect(migrated.sqlite.query("PRAGMA user_version").get()).toEqual({ user_version: 7 })
    expect(
      migrated.sqlite
        .query("SELECT boundary, halo, onboarding_version, hub_url, timezone FROM settings WHERE id = 1")
        .get(),
    ).toEqual({
      boundary: 7,
      halo: 15,
      onboarding_version: 0,
      hub_url: "http://127.0.0.1:7412/",
      timezone: "America/Los_Angeles",
    })
    expect(migrated.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "7" })
    expect(migrated.sqlite.query("SELECT source_session_id, first_prompt FROM sessions").get()).toEqual({
      source_session_id: "legacy-session",
      first_prompt: "Preserve me",
    })
  })

  test("derives cutoff workdays in the protocol timezone", () => {
    const parts = localParts(Date.parse("2026-07-01T12:30:00.000Z"), "America/Los_Angeles")
    expect(parts).toEqual({ date: "2026-07-01", minute: 330 })
    expect(workdayOf(parts.date, parts.minute, 6)).toBe("2026-06-30")
  })
})
