import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server/app"
import { issueCredential } from "../server/auth"
import { openDatabase, type TrailsDb } from "../server/db"
import { ingestSessions } from "../server/ingest"
import { chargeBudget, RESOURCE_LIMITS } from "../server/resources"
import { runSummaryPoll } from "../server/summaries"
import { SummarizeError, type Summarizer } from "../server/harnesses/types"
import { decodeExact, IngestRequestV2Schema, type IngestSessionV2 } from "../shared/protocol"
import { INGEST_LIMITS } from "../shared/limits"

const databases: TrailsDb[] = []
const roots: string[] = []
const now = Date.parse("2026-08-01T12:00:00.000Z")
const minute = now / 60_000
function database(path = ":memory:") {
  const db = openDatabase(path, { defaultTimezone: "UTC" })
  databases.push(db)
  return db
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function session(id: string, count = 1): IngestSessionV2 {
  return {
    sourceSessionId: id, source: "omp", cwd: "/test/project", branch: null,
    start: new Date(now).toISOString(), end: new Date(now + count * 60_000).toISOString(),
    events: count * 2, userEvents: count, firstPrompt: "Synthetic prompt", digest: "Synthetic digest",
    activity: Array.from({ length: count }, (_, i) => [minute + i, 2, 1]),
  }
}
const body = (sessions: readonly IngestSessionV2[], id = "device") => ({
  protocolVersion: 2 as const, device: { id, name: id }, sessions,
})
function client(db: TrailsDb, id = "device", clock = () => now) {
  const token = issueCredential(db, "collector", id).token
  const app = createApp({ db, now: clock })
  return {
    app,
    post: (sessions: readonly IngestSessionV2[]) => app(new Request("http://localhost:7412/api/ingest", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body(sessions, id)),
    })),
    token,
  }
}
function count(db: TrailsDb, table: string) {
  return (db.sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
}
function fillBudget(db: TrailsDb, scope: string, kind: string, used: number) {
  db.sqlite.query("INSERT OR REPLACE INTO resource_budgets VALUES (?, ?, ?, ?)").run(scope, kind, now, used)
}

describe("bounded ingest resources", () => {
  test("accepts exact tuple limits and rejects excess tuples and spans before writes", async () => {
    const db = database()
    const { post } = client(db)
    expect((await post([session("a", 2048), session("b", 2048)])).status).toBe(200)
    expect((await post([session("c", 2049)])).status).toBe(400)
    expect((await post([session("c", 2048), session("d", 2048), session("e")])).status).toBe(400)
    const tooWide: IngestSessionV2 = { ...session("wide", 2), activity: [[minute, 2, 1], [minute + INGEST_LIMITS.spanMinutes + 1, 2, 1]] }
    expect((await post([tooWide])).status).toBe(400)
    expect((await post([{ ...session("long"), end: new Date(now + 32 * 86_400_000).toISOString() }])).status).toBe(400)
    expect(count(db, "sessions")).toBe(2)
    expect(() => decodeExact(IngestRequestV2Schema, body([session("oversize", 2049)]))).toThrow()
  })

  test("rate limits before reading a body, shares the device gate across tokens, and recovers", async () => {
    const db = database()
    let clock = now
    const a = client(db, "device", () => clock)
    for (let i = 0; i < 30; i++) expect((await a.post([session("replay")])).status).toBe(200)
    const b = client(db, "device", () => clock)
    const limited = await b.post([session("other")])
    expect(limited.status).toBe(429)
    expect(limited.headers.get("Retry-After")).toBe("60")
    expect((await a.app(new Request("http://localhost:7412/api/health"))).status).toBe(200)
    clock += 60_000
    expect((await b.post([session("other")])).status).toBe(200)
  })

  test("limits concurrent slow readers and releases admission on completion", async () => {
    const db = database()
    const { app, post, token } = client(db)
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value } })
    const pending = app(new Request("http://localhost:7412/api/ingest", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: stream,
    }))
    expect((await post([session("second")])).status).toBe(429)
    expect((await app(new Request("http://localhost:7412/api/health"))).status).toBe(200)
    controller.enqueue(new TextEncoder().encode(JSON.stringify(body([session("first")]))))
    controller.close()
    expect((await pending).status).toBe(200)
    expect((await post([session("second")])).status).toBe(200)
  })

  test("quota failure rolls back a whole batch, and replay avoids activity writes and budget charges", async () => {
    const db = database()
    const { post } = client(db)
    expect((await post([session("first")])).status).toBe(200)
    fillBudget(db, "device:device", "admission", RESOURCE_LIMITS.deviceAdmissions - 1)
    const revision = db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()
    expect((await post([session("second"), session("third")])).status).toBe(429)
    expect(count(db, "sessions")).toBe(1)
    expect(db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual(revision)
    expect((db.sqlite.query("SELECT used FROM resource_budgets WHERE scope = 'device:device' AND kind = 'admission'").get() as { used: number }).used).toBe(RESOURCE_LIMITS.deviceAdmissions - 1)
    db.sqlite.exec("CREATE TRIGGER forbid_activity BEFORE INSERT ON session_activity BEGIN SELECT RAISE(ABORT, 'replay wrote activity'); END")
    fillBudget(db, "device:device", "admission", RESOURCE_LIMITS.deviceAdmissions)
    expect(await (await post([session("first")])).json()).toMatchObject({ accepted: 0, unchanged: 1 })
    expect((await post([session("fourth")])).status).toBe(429)
  })

  test("enforces device tuple capacity atomically and retains readable history", async () => {
    const db = database()
    const { post, app } = client(db)
    // Under 50k rows total; intentionally bounded local synthetic load.
    for (let i = 0; i < 12; i++) expect((await post([session(`a${i}`, 2048), session(`b${i}`, 2048)])).status).toBe(200)
    expect(count(db, "session_activity")).toBe(49_152)
    expect((await post([session("overflow", 2048)])).status).toBe(507)
    expect(count(db, "session_activity")).toBe(49_152)
    expect(count(db, "sessions")).toBe(24)
    expect((await post([session("a0", 2048)])).status).toBe(200)
    const owner = issueCredential(db, "owner")
    const started = performance.now()
    const bootstrap = await app(new Request("http://localhost:7412/api/bootstrap", {
      headers: { Authorization: `Bearer ${owner.token}` },
    }))
    expect(bootstrap.status).toBe(200)
    const payload = await bootstrap.json() as { sessions: unknown[] }
    expect(payload.sessions).toHaveLength(24)
    console.log(`TRL-12 synthetic bootstrap: ${(performance.now() - started).toFixed(1)}ms for 49,152 tuples`)
  })

  test("caps device and global queue size, including day jobs", async () => {
    const db = database()
    const { post } = client(db)
    expect((await post([session("first")])).status).toBe(200)
    const insert = db.sqlite.query("INSERT INTO day_summary_jobs VALUES (?, '/test/project', 6, 1, 0, ?, NULL)")
    db.sqlite.transaction(() => { for (let i = 0; i < RESOURCE_LIMITS.deviceQueue; i++) insert.run(`synthetic-${i}`, now) })()
    const before = count(db, "day_summary_jobs")
    expect((await post([session("second")])).status).toBe(429)
    expect(count(db, "sessions")).toBe(1)
    expect(count(db, "day_summary_jobs")).toBe(before)
    expect((await post([session("first")])).status).toBe(200)
    db.sqlite.exec("DELETE FROM day_summary_jobs")
    const global = db.sqlite.query("INSERT INTO day_summary_jobs VALUES (?, 'other/project', 6, 1, 0, ?, NULL)")
    db.sqlite.transaction(() => { for (let i = 0; i < RESOURCE_LIMITS.queue - 1; i++) global.run(`synthetic-${i}`, now) })()
    expect((await post([session("third")])).status).toBe(429)
    expect(count(db, "sessions")).toBe(1)
  })

  test("capture attention and image storage obey quotas and replay remains cheap", async () => {
    const db = database()
    const { app, token } = client(db)
    const capture = {
      source: "midjourney", sourceRecordId: "image", project: null, projectHint: null,
      title: "Synthetic image", startedAt: new Date(now).toISOString(), endedAt: null,
      summaryInput: "Synthetic capture", attentionMinutes: [minute],
      payload: { eventType: "imagine", jobType: "grid", parentSourceRecordId: null, parentGrid: null },
      images: Array.from({ length: 4 }, (_, index) => ({ index, mime: "image/png", width: 1, height: 1, bytes: "AAAA" })),
    }
    const post = (captures: unknown[]) => app(new Request("http://localhost:7412/api/captures", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, device: { id: "device", name: "device" }, captures }),
    }))
    expect((await post([{ ...capture, attentionMinutes: Array.from({ length: 2049 }, (_, i) => minute + i) }])).status).toBe(400)
    expect((await post([{ ...capture, attentionMinutes: [minute, minute + INGEST_LIMITS.spanMinutes + 1] }])).status).toBe(400)
    expect((await post([capture])).status).toBe(200)
    // A zero-filled in-memory legacy blob exercises the byte quota without
    // writing a large fixture or allocating a base64 request on disk.
    db.sqlite.query("UPDATE capture_images SET bytes = zeroblob(?) WHERE image_index = 0")
      .run(RESOURCE_LIMITS.deviceImageBytes)
    expect((await post([{ ...capture, sourceRecordId: "overflow" }])).status).toBe(507)
    expect(count(db, "captures")).toBe(1)
    expect(count(db, "capture_images")).toBe(4)
    expect(await (await post([capture])).json()).toMatchObject({ unchanged: 1, accepted: 0 })
  })

  test("record quotas reject new records and legacy bootstrap fails before materializing activity", async () => {
    const db = database()
    const { post, app } = client(db)
    expect((await post([session("seed")])).status).toBe(200)
    const insert = db.sqlite.query(`INSERT INTO captures(machine_id, source, source_record_id,
      title, started_at, summary_input, provider_payload, content_hash, updated_at)
      VALUES ('device', 'granola', ?, 'Synthetic', '2026-08-01T12:00:00.000Z', 'Synthetic', '{}', 'hash', ?)`)
    db.sqlite.transaction(() => {
      for (let i = 0; i < RESOURCE_LIMITS.deviceRecords; i++) insert.run(`quota-${i}`, now)
    })()
    expect((await post([session("overflow")])).status).toBe(507)
    expect(count(db, "sessions")).toBe(1)
    db.sqlite.transaction(() => {
      for (let i = RESOURCE_LIMITS.deviceRecords; i < RESOURCE_LIMITS.records; i++) insert.run(`quota-${i}`, now)
    })()
    const owner = issueCredential(db, "owner")
    const response = await app(new Request("http://localhost:7412/api/bootstrap", {
      headers: { Authorization: `Bearer ${owner.token}` },
    }))
    expect(response.status).toBe(507)
    expect((await app(new Request("http://localhost:7412/api/health"))).status).toBe(200)
  })

  test("SQLite disk-full errors return 507 and leave no partial state", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-quota-")); roots.push(root)
    const db = database(join(root, "test.sqlite"))
    const { post, app } = client(db)
    const pages = (db.sqlite.query("PRAGMA page_count").get() as { page_count: number }).page_count
    db.sqlite.exec(`PRAGMA max_page_count=${pages}`)
    const response = await post([session("full", 2048)])
    expect(response.status).toBe(507)
    expect(await response.json()).toMatchObject({ error: { code: "storage_full" } })
    expect(count(db, "sessions")).toBe(0)
    expect(count(db, "machines")).toBe(0)
    expect(count(db, "resource_budgets")).toBe(0)
    expect((await app(new Request("http://localhost:7412/api/health"))).status).toBe(200)
  })

  test("bounded synthetic burst keeps health responsive on a real HTTP listener", async () => {
    const db = database()
    const { app, token } = client(db)
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app })
    const headers = { Host: "localhost:7412", Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    let worst = 0
    try {
      for (let i = 0; i < 8; i++) {
        const start = performance.now()
        const ingest = fetch(`http://127.0.0.1:${server.port}/api/ingest`, { method: "POST", headers, body: JSON.stringify(body([session(`stress-${i}`, 2048)])) })
        const health = await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers })
        await health.text()
        worst = Math.max(worst, performance.now() - start)
        expect(health.status).toBe(200)
        const response = await ingest
        expect(response.status).toBe(200)
        await response.text()
      }
      console.log(`TRL-12 synthetic health: ${worst.toFixed(1)}ms worst over 8 x 2048-tuple batches`)
      expect(worst).toBeLessThan(1000)
    } finally { await server.stop(true) }
  })
})

describe("durable paid summary budgets", () => {
  test("reserves attempts before invocation, persists across restart, and resets after 24 hours", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-budget-")); roots.push(root)
    const path = join(root, "test.sqlite")
    let db = database(path)
    await Effect.runPromise(ingestSessions(db, body([session("paid")]), now))
    fillBudget(db, "device:device", "call", RESOURCE_LIMITS.deviceCalls - 1)
    let calls = 0
    const summarizer: Summarizer = { harness: "omp", summarize: () => { calls++; return Effect.fail(new SummarizeError("harness_failed")) } }
    await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + 300_000 }))
    expect(calls).toBe(1)
    databases.splice(databases.indexOf(db), 1); db.close(); db = database(path)
    await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + 3_600_000 }))
    expect(calls).toBe(1)
    await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + 86_400_000 }))
    expect(calls).toBe(2)
  })

  test("global exhaustion cannot be bypassed by another device and rolls back reservations", () => {
    const db = database()
    fillBudget(db, "global", "call", RESOURCE_LIMITS.calls)
    expect(() => db.sqlite.transaction(() => chargeBudget(db, "call", ["another"], now))()).toThrow()
    expect(count(db, "resource_budgets")).toBe(1)
    fillBudget(db, "global", "call", 0)
    fillBudget(db, "device:blocked", "call", RESOURCE_LIMITS.deviceCalls)
    expect(() => db.sqlite.transaction(() => chargeBudget(db, "call", ["another", "blocked"], now))()).toThrow()
    expect(db.sqlite.query("SELECT * FROM resource_budgets WHERE scope = 'device:another'").get()).toBeNull()
  })

  test("paid day summaries charge each contributing device and copying is free", async () => {
    const db = database()
    await Effect.runPromise(ingestSessions(db, body([session("a")], "a"), now))
    await Effect.runPromise(ingestSessions(db, body([session("b")], "b"), now))
    db.sqlite.exec(`INSERT INTO session_summaries SELECT id, digest_hash, 'synthetic', 'summary', ${now} FROM sessions`)
    db.sqlite.exec("DELETE FROM session_summary_jobs")
    let calls = 0
    const summarizer: Summarizer = { harness: "omp", summarize: () => { calls++; return Effect.succeed({ text: "day", model: "synthetic" }) } }
    await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + 300_000 }))
    expect(calls).toBe(1)
    const budgets = db.sqlite.query("SELECT scope, used FROM resource_budgets WHERE kind = 'call' ORDER BY scope").all()
    expect(budgets).toEqual([{ scope: "device:a", used: 1 }, { scope: "device:b", used: 1 }, { scope: "global", used: 1 }])
    await Effect.runPromise(ingestSessions(db, body([{ ...session("copy"), cwd: "/another/project", digest: null }], "c"), now))
    await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + 300_000 }))
    expect(calls).toBe(1)
    expect(count(db, "day_summaries")).toBe(2)
  })

  test("failed jobs stop invoking the provider after five attempts", async () => {
    const db = database()
    await Effect.runPromise(ingestSessions(db, body([session("retry")]), now))
    let calls = 0
    const summarizer: Summarizer = { harness: "omp", summarize: () => { calls++; return Effect.fail(new SummarizeError("harness_failed")) } }
    for (let i = 0; i < 10; i++) await Effect.runPromise(runSummaryPoll({ db, summarizer: () => summarizer, now: now + (i + 1) * 3_600_000 }))
    expect(calls).toBe(5)
  })
})
