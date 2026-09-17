import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createApp, bootstrapOf } from "../server/app"
import { issueCredential, revokeCredential } from "../server/auth"
import { assignCaptureAccount, reconcileCaptureAccount } from "../server/capture-accounts"
import { ingestCaptures } from "../server/captures"
import { openDatabase, type TrailsDb } from "../server/db"
import { MIGRATIONS } from "../server/migrations"
import { runAuthCommand } from "../cli/auth"
import type { IngestCaptureV1, IngestCapturesRequestV1, MidjourneyCaptureV1 } from "../shared/protocol"

const databases: TrailsDb[] = []
const roots: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function database(path = ":memory:") {
  const db = openDatabase(path, { defaultTimezone: "UTC" })
  databases.push(db)
  return db
}
function temporaryPath() {
  const root = mkdtempSync(join(tmpdir(), "trails-capture-ownership-"))
  roots.push(root)
  return join(root, "hub.sqlite")
}
const now = Date.parse("2026-09-16T12:00:00.000Z")
function capture(id = "shared-record", overrides: Partial<MidjourneyCaptureV1> = {}): MidjourneyCaptureV1 {
  return {
    source: "midjourney", sourceRecordId: id, project: "/code/project-a", projectHint: "Original hint",
    title: "Original title", startedAt: new Date(now).toISOString(), endedAt: null,
    summaryInput: "Original content", attentionMinutes: [now / 60000],
    payload: { eventType: "imagine", jobType: "generation", parentSourceRecordId: null, parentGrid: null },
    images: Array.from({ length: 4 }, (_, index) => ({ index, mime: "image/webp", width: 640, height: 640,
      bytes: Buffer.from(`RIFF synthetic original ${index}`).toString("base64") })),
    ...overrides,
  }
}
function client(db: TrailsDb, id: string) {
  const credential = issueCredential(db, "collector", id)
  const app = createApp({ db, now: () => now })
  const body = (captures: IngestCaptureV1[]): IngestCapturesRequestV1 => ({
    protocolVersion: 1, device: { id, name: id }, captures,
  })
  return { credential, body, post: (captures: IngestCaptureV1[], extra: object = {}) => app(new Request("http://localhost:7412/api/captures", {
    method: "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ...body(captures), ...extra }),
  })) }
}
function snapshot(db: TrailsDb) {
  return Object.fromEntries(["captures", "capture_images", "capture_attention", "machines", "meta"].map(table =>
    [table, db.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

describe("capture ownership", () => {
  test("paired device B cannot overwrite A, even with identical content; the full batch rolls back", async () => {
    const db = database(), a = client(db, "owner-a"), b = client(db, "owner-b")
    expect((await a.post([capture()])).status).toBe(200)
    // Exercise rollback of an existing machine rename/last_seen as well as a new capture.
    expect((await b.post([capture("b-record")])).status).toBe(200)
    const before = snapshot(db)
    const replacement = capture(undefined, { title: "replacement by B", project: "/code/stolen",
      projectHint: "stolen", summaryInput: "replacement", attentionMinutes: [now / 60000 + 1],
      images: capture().images.map(image => ({ ...image, bytes: Buffer.from("replacement").toString("base64") })) })
    const response = await b.post([capture("batch-first"), replacement], { device: { id: "owner-b", name: "Renamed B" } })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } })
    expect(snapshot(db)).toEqual(before)
    expect((await b.post([capture()])).status).toBe(403)
    expect(snapshot(db)).toEqual(before)
    expect((await b.post([capture()], { accountId: "claimed-owner" })).status).toBe(400)
    expect(snapshot(db)).toEqual(before)
    const c = client(db, "new-machine")
    expect((await c.post([capture("new-first"), replacement])).status).toBe(403)
    expect(snapshot(db)).toEqual(before)
  })

  test("the Granola audit overwrite returns forbidden for a separately paired device", async () => {
    const db = database(), a = client(db, "owner-a"), b = client(db, "owner-b")
    const item: IngestCaptureV1 = {
      ...capture("synthetic-capture"), source: "granola", images: [],
      payload: { attendeeCount: 1, folders: [], webUrl: null },
    }
    expect((await a.post([item])).status).toBe(200)
    const before = snapshot(db)
    expect((await b.post([{ ...item, title: "replacement by B" }])).status).toBe(403)
    expect(snapshot(db)).toEqual(before)
  })

  test("explicit same-account authorization reconciles replay across devices and can be revoked", async () => {
    const db = database(), a = client(db, "owner-a"), b = client(db, "owner-b")
    await a.post([capture()])
    const original = db.sqlite.query("SELECT * FROM captures").get() as { id: number }
    assignCaptureAccount(db, "midjourney", "owner-a", "personal")
    assignCaptureAccount(db, "midjourney", "owner-b", "personal")
    reconcileCaptureAccount(db, original.id, "owner-a", "midjourney", "personal")
    const children = snapshot(db)
    const response = await b.post([capture(undefined, { project: null })])
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: 1, unchanged: 0 })
    expect(db.sqlite.query("SELECT id, machine_id, owner_machine_id, account_id, project FROM captures").get()).toEqual({
      id: original.id, machine_id: "owner-b", owner_machine_id: "owner-a", account_id: "personal", project: "/code/project-a",
    })
    expect(snapshot(db).capture_images).toEqual(children.capture_images)
    expect(snapshot(db).capture_attention).toEqual(children.capture_attention)
    expect(await (await b.post([capture(undefined, { project: null })])).json()).toMatchObject({ accepted: 0, unchanged: 1 })
    expect((await a.post([capture(undefined, { title: "Authorized update" })])).status).toBe(200)
    // Provider-scoped: a Granola assignment does not authorize Midjourney reconciliation.
    assignCaptureAccount(db, "midjourney", "owner-b", null)
    assignCaptureAccount(db, "granola", "owner-b", "personal")
    const before = db.sqlite.query("SELECT * FROM captures").all()
    await b.post([capture(undefined, { title: "Outside account" })])
    expect(db.sqlite.query("SELECT * FROM captures WHERE account_id = 'personal'").all()).toEqual(before)
    assignCaptureAccount(db, "midjourney", "owner-b", "personal")
    revokeCredential(db, b.credential.id)
    const snapshotBefore = snapshot(db)
    expect((await b.post([capture()])).status).toBe(401)
    await expect(Effect.runPromise(ingestCaptures(db, b.body([capture()]), b.credential))).rejects.toThrow("capture ownership")
    expect(snapshot(db)).toEqual(snapshotBefore)
  })

  test("independent accounts deduplicate separately and parent links stay in the same account", async () => {
    const db = database(), a = client(db, "a"), b = client(db, "b")
    assignCaptureAccount(db, "midjourney", "a", "account-a")
    assignCaptureAccount(db, "midjourney", "b", "account-b")
    const child = capture("child", { payload: { ...capture().payload, parentSourceRecordId: "shared-record" } })
    await a.post([capture(), child])
    await b.post([capture(undefined, { title: "B's independent record" }), child])
    expect(db.sqlite.query("SELECT count(*) AS count FROM captures").get()).toEqual({ count: 4 })
    const rows = db.sqlite.query("SELECT id, account_id, source_record_id FROM captures").all() as Array<{ id: number; account_id: string; source_record_id: string }>
    const bootstrap = bootstrapOf(db, now)
    for (const row of rows.filter(row => row.source_record_id === "child")) {
      const parent = rows.find(parent => parent.account_id === row.account_id && parent.source_record_id === "shared-record")!
      expect(bootstrap.captures.find(item => item.id === String(row.id))?.payload).toMatchObject({ parentCaptureId: String(parent.id) })
    }
    const loneChild = capture("lone-child", { payload: { ...child.payload, parentSourceRecordId: "only-a" } })
    await a.post([capture("only-a")])
    await b.post([loneChild])
    expect(bootstrapOf(db, now).captures.at(-1)?.payload).toMatchObject({ parentCaptureId: null })
  })

  test("owner reconciliation checks expected ownership, requires assignment, and rejects collisions atomically", async () => {
    const db = database(), a = client(db, "a"), b = client(db, "b")
    await a.post([capture()])
    const id = (db.sqlite.query("SELECT id FROM captures").get() as { id: number }).id
    expect(() => reconcileCaptureAccount(db, id, "a", "midjourney", "account")).toThrow("assign")
    assignCaptureAccount(db, "midjourney", "a", "account")
    assignCaptureAccount(db, "midjourney", "b", "account")
    expect(() => reconcileCaptureAccount(db, id, "b", "midjourney", "account")).toThrow("expected owner")
    await b.post([capture()])
    const before = snapshot(db)
    expect(() => reconcileCaptureAccount(db, id, "a", "midjourney", "account")).toThrow("UNIQUE")
    expect(snapshot(db)).toEqual(before)
    expect(() => assignCaptureAccount(db, "midjourney", "unpaired", "account")).toThrow("paired")
    expect(() => assignCaptureAccount(db, "midjourney", "a", "")).toThrow("1..128")
    expect(() => assignCaptureAccount(db, "unknown", "a", "account")).toThrow("unsupported")
  })

  test("hub-owner CLI assigns, reconciles, and revokes without rewriting capture content", async () => {
    const path = temporaryPath(), db = database(path), a = client(db, "a")
    await a.post([capture()])
    const id = (db.sqlite.query("SELECT id FROM captures").get() as { id: number }).id
    const common = ["--db", path, "--source", "midjourney"]
    runAuthCommand(["capture-account", ...common, "--device-id", "a", "--account", "personal"])
    runAuthCommand(["capture-reconcile", ...common, "--capture-id", String(id), "--owner-device-id", "a", "--account", "personal"])
    expect(db.sqlite.query("SELECT account_id, title FROM captures").get()).toEqual({ account_id: "personal", title: "Original title" })
    runAuthCommand(["capture-account", ...common, "--device-id", "a", "--revoke"])
    expect(db.sqlite.query("SELECT * FROM capture_device_accounts").all()).toEqual([])
  })

  test("migration preserves legacy IDs, blobs, attribution and original ownership across reopen", async () => {
    const path = temporaryPath(), legacy = new Database(path)
    legacy.exec("PRAGMA foreign_keys = ON")
    for (const migration of MIGRATIONS.filter(migration => migration.version <= 7)) legacy.exec(migration.sql)
    legacy.exec("PRAGMA user_version = 7")
    legacy.query("INSERT INTO machines(id, name, first_seen_at, last_seen_at) VALUES ('legacy-a', 'A', ?, ?)").run(now, now)
    const item = capture()
    legacy.query(`INSERT INTO captures(id, machine_id, source, source_record_id, project, project_hint, title,
      started_at, summary_input, provider_payload, content_hash, updated_at) VALUES (42, 'legacy-a', ?, ?, ?, ?, ?, ?, ?, ?, 'hash', ?)`)
      .run(item.source, item.sourceRecordId, item.project, item.projectHint, item.title, item.startedAt, item.summaryInput, JSON.stringify(item.payload), now)
    legacy.query("INSERT INTO capture_attention VALUES (42, ?)").run(now / 60000)
    legacy.query("INSERT INTO capture_images VALUES (42, 0, 'image/webp', 640, 640, ?, 'image-hash')").run(Buffer.from("legacy image"))
    const previous = legacy.query("SELECT * FROM captures").get()
    const images = legacy.query("SELECT * FROM capture_images").all()
    const attention = legacy.query("SELECT * FROM capture_attention").all()
    legacy.close()
    const db = database(path)
    expect(db.sqlite.query("SELECT * FROM captures").get()).toEqual({ ...previous!, account_id: "", owner_machine_id: "legacy-a" })
    expect(db.sqlite.query("SELECT * FROM capture_images").all()).toEqual(images)
    expect(db.sqlite.query("SELECT * FROM capture_attention").all()).toEqual(attention)
    expect(db.sqlite.query("PRAGMA foreign_key_check").all()).toEqual([])
    expect((await client(db, "legacy-b").post([capture()])).status).toBe(403)
    const reopened = database(path)
    expect(reopened.sqlite.query("SELECT id, owner_machine_id FROM captures").get()).toEqual({ id: 42, owner_machine_id: "legacy-a" })
    expect((await client(reopened, "legacy-a").post([capture("new-record")])).status).toBe(200)
    expect((reopened.sqlite.query("SELECT MAX(id) AS id FROM captures").get() as { id: number }).id).toBeGreaterThan(42)
  })
})
