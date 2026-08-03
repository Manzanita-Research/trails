import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import { sessionContentHash } from "../server/ingest"
import { MIGRATIONS } from "../server/migrations"
import type { BootstrapV1, IngestRequestV1, IngestSessionV1 } from "../shared/protocol"

const roots = new Set<string>()
const databases = new Set<TrailsDb>()

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "trails-server-test-"))
  roots.add(root)
  return root
}

function trackedDatabase(path: string): TrailsDb {
  const database = openDatabase(path)
  databases.add(database)
  return database
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
  overrides: Partial<IngestSessionV1> = {},
): IngestSessionV1 {
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
    activity: [["2026-08-03", 540, 2, 1]],
    digest: "A bounded private digest",
    ...overrides,
  }
}

function ingestBody(
  sessions: ReadonlyArray<IngestSessionV1>,
  device = { id: "device-a", name: "Studio" },
): IngestRequestV1 {
  return { protocolVersion: 1, device, sessions }
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

    expect(MIGRATIONS.map(({ version }) => version)).toEqual([1])
    expect(new Set(MIGRATIONS.map(({ version }) => version)).size).toBe(MIGRATIONS.length)
    expect(MIGRATIONS.every((migration, index) => index === 0 || MIGRATIONS[index - 1]!.version < migration.version)).toBe(true)
    expect(database.path).toBe(resolve(path))
    const userVersion = database.sqlite.query("PRAGMA user_version").get() as { user_version: number }
    const journalMode = database.sqlite.query("PRAGMA journal_mode").get() as { journal_mode: string }
    const foreignKeys = database.sqlite.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    const busyTimeout = database.sqlite.query("PRAGMA busy_timeout").get() as Record<string, number>
    expect(userVersion.user_version).toBe(1)
    expect(journalMode.journal_mode).toBe("wal")
    expect(foreignKeys.foreign_keys).toBe(1)
    expect(Object.values(busyTimeout)[0]).toBe(5000)
    expect(database.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "0" })
    expect(database.sqlite.query("SELECT boundary, halo FROM settings WHERE id = 1").get()).toEqual({ boundary: 6, halo: 10 })

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
      ]),
    )
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, "nested"))).mode & 0o777).toBe(0o700)

    database.sqlite.query("UPDATE settings SET halo = 15 WHERE id = 1").run()
    closeDatabase(database)
    const reopened = trackedDatabase(path)
    const reopenedVersion = reopened.sqlite.query("PRAGMA user_version").get() as { user_version: number }
    expect(reopenedVersion.user_version).toBe(1)
    expect(reopened.sqlite.query("SELECT boundary, halo FROM settings WHERE id = 1").get()).toEqual({ boundary: 6, halo: 15 })
  })
})

describe("ingest and bootstrap", () => {
  test("upserts by machine/source/session, replaces activity, and revisions only visible changes", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ db: database })
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
        ["2026-08-03", 540, 1, 1],
        ["2026-08-03", 542, 3, 1],
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
      .query("SELECT local_date, minute, event_count, user_event_count FROM session_activity ORDER BY minute")
      .all()).toEqual([
      { local_date: "2026-08-03", minute: 540, event_count: 1, user_event_count: 1 },
      { local_date: "2026-08-03", minute: 542, event_count: 3, user_event_count: 1 },
    ])

    response = await request(app, "POST", "/api/ingest", ingestBody([changed], { id: "device-b", name: "Laptop" }))
    expect(await json(response)).toEqual({ accepted: 1, unchanged: 0, revision: 4 })

    response = await request(app, "GET", "/api/bootstrap")
    expect(response.status).toBe(200)
    const bootstrap = await json<BootstrapV1>(response)
    expect(bootstrap.protocolVersion).toBe(1)
    expect(bootstrap.revision).toBe(4)
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
      assignments: {},
      customEngagements: [],
      names: {},
      pocket: [],
    })
  })

  test("accepts the 50-session boundary and rejects 51 before changing the database", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ db: database })
    const fifty = Array.from({ length: 50 }, (_, index) => session(`session-${index}`))

    let response = await request(app, "POST", "/api/ingest", ingestBody(fifty))
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
    const app = createApp({ db: database })
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

describe("state mutation API", () => {
  test("enforces mutation status, validation, field presence, and exact no-op revisions", async () => {
    const root = await temporaryRoot()
    const database = trackedDatabase(join(root, "trails.sqlite"))
    const app = createApp({ db: database })
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
    const app = createApp({ db: database, staticRoot })

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

    const apiOnly = createApp({ db: database })
    response = await request(apiOnly, "GET", "/anything")
    expect(response.status).toBe(404)
    expect(await json(response)).toEqual({ error: { code: "not_found", message: "static serving is disabled" } })
    response = await request(apiOnly, "GET", "/api/health")
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({ ok: true, revision: 0 })

    expect(await readFile(join(root, "outside.txt"), "utf8")).toBe("must not escape")
    expect(await readdir(staticRoot)).toEqual(expect.arrayContaining(["index.html", "app-12345678.js", "plain.css"]))
  })
})
