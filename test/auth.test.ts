import { afterEach, describe, expect, mock, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { createApp } from "../server/app"
import { credentialFor, initializeOwner, issueCredential, ownerTokenPath, readPrivateFile, revokeCredential, rotateOwner } from "../server/auth"
import { openDatabase, type TrailsDb } from "../server/db"
import { configureCollector, importCollectorPairing, loadCollectorConfig } from "../cli/config"
import { runAuthCommand } from "../cli/auth"
import { runCollection } from "../collector/sync"
import { readerToken } from "../shared/reader-credential"

const databases: TrailsDb[] = []
const roots: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function root() { const path = mkdtempSync(join(tmpdir(), "trails-auth-")); roots.push(path); return path }
function database(path = ":memory:") { const db = openDatabase(path); databases.push(db); return db }
const origin = "http://localhost:7412"
function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") {
  return new Request(origin + path, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers,
  }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const session = { sourceSessionId: "fixture", source: "claude", cwd: "/tmp/project", branch: null,
  start: "2026-09-16T12:00:00.000Z", end: "2026-09-16T12:00:00.000Z", events: 2, userEvents: 1,
  firstPrompt: "Fixture", activity: [[Date.parse("2026-09-16T12:00:00Z") / 60000, 2, 1]], digest: null }
const capture = { source: "granola", sourceRecordId: "fixture", project: null, projectHint: null, title: "Fixture",
  startedAt: "2026-09-16T12:00:00.000Z", endedAt: null, summaryInput: "Fixture", attentionMinutes: [Date.parse("2026-09-16T12:00:00Z") / 60000],
  payload: { attendeeCount: 1, folders: [], webUrl: null }, images: [] }
const status = (id: string) => ({ protocolVersion: 1, device: { id, name: "Fixture" }, outcome: { status: "failed", metrics: null, error: "collector_error" } })

describe("hub authentication and pairing", () => {
  test("fails closed before and after local owner setup, including the audit read/admin probes", async () => {
    const db = database()
    const activate = mock(() => {})
    const app = createApp({ db, harnesses: { activate, disconnect: mock(() => {}), status: () => ({ protocolVersion: 1, active: null, harnesses: [] }) } })
    for (const setup of [false, true]) {
      if (setup) issueCredential(db, "owner")
      for (const path of ["/api/bootstrap", "/api/bootstrap?after=0", "/api/machines", "/api/harnesses", "/api/summarization", "/api/capture-images/1/0"]) {
        expect((await app(request(path))).status).toBe(401)
        expect((await app(request(path, "invalid"))).status).toBe(401)
      }
      for (const [path, body] of [["/api/pocket", { text: "unauthorized" }], ["/api/summarizer", { harness: "codex" }], ["/api/collector-status", status("forged")]] as const) {
        expect((await app(request(path, undefined, body))).status).toBe(401)
      }
      expect((await app(request("/api/auth/login", undefined, { token: "first-visitor" }))).status).toBe(401)
    }
    expect(activate).not.toHaveBeenCalled()
    expect(db.sqlite.query("SELECT count(*) AS n FROM pocket_items").get()).toEqual({ n: 0 })
    expect(await (await app(request("/api/health"))).json() as unknown).toEqual({ ok: true })
  })

  test("enforces owner/read/collector permissions and authorizes summary activation only for the owner", async () => {
    const db = database()
    const owner = issueCredential(db, "owner"), reader = issueCredential(db, "read"), collector = issueCredential(db, "collector", "mac-a")
    const activate = mock(() => {})
    const app = createApp({ db, harnesses: { activate, disconnect: mock(() => {}), status: () => ({ protocolVersion: 1, active: null, harnesses: [] }) } })
    for (const credential of [reader, collector]) {
      expect((await app(request("/api/summarizer", credential.token, { harness: "codex" }))).status).toBe(403)
      expect((await app(request("/api/settings", credential.token, { halo: 0 }, {}, "PATCH"))).status).toBe(403)
      expect((await app(request("/api/pocket", credential.token, { text: "no" }))).status).toBe(403)
      expect((await app(request("/api/auth/login", undefined, { token: credential.token }))).status).toBe(401)
    }
    expect(activate).not.toHaveBeenCalled()
    expect((await app(request("/api/summarizer", owner.token, { harness: "codex" }))).status).toBe(200)
    expect(activate).toHaveBeenCalledTimes(1)
    for (const credential of [owner, reader]) {
      expect((await app(request("/api/bootstrap", credential.token))).status).toBe(200)
      expect((await app(request("/api/collector-status", credential.token, status("mac-a")))).status).toBe(403)
    }
    expect((await app(request("/api/bootstrap", collector.token))).status).toBe(403)
    expect((await app(request("/api/machines", collector.token))).status).toBe(403)
    expect((await app(request("/api/collector-status", collector.token, status("mac-a")))).status).toBe(204)
  })

  test("rejects forged device IDs on sessions, captures, and status before any mutation", async () => {
    const db = database(), collector = issueCredential(db, "collector", "mac-a")
    const app = createApp({ db })
    const bodies = [
      ["/api/ingest", { protocolVersion: 2, device: { id: "mac-b", name: "Forged" }, sessions: [session] }],
      ["/api/captures", { protocolVersion: 1, device: { id: "mac-b", name: "Forged" }, captures: [capture] }],
      ["/api/collector-status", status("mac-b")],
    ] as const
    for (const [path, body] of bodies) expect((await app(request(path, collector.token, body))).status).toBe(403)
    expect(db.sqlite.query("SELECT count(*) AS n FROM machines").get()).toEqual({ n: 0 })
    expect(db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "0" })
    expect((await app(request("/api/ingest", collector.token, { protocolVersion: 2, device: { id: "mac-a", name: "A" }, sessions: [session] }))).status).toBe(200)
  })

  test("revocation is immediate across live app instances and does not remove history", async () => {
    const db = database(join(root(), "hub.sqlite"))
    const collector = issueCredential(db, "collector", "mac-a"), reader = issueCredential(db, "read")
    const app = createApp({ db })
    expect((await app(request("/api/collector-status", collector.token, status("mac-a")))).status).toBe(204)
    const admin = database(db.path)
    revokeCredential(admin, collector.id)
    revokeCredential(admin, reader.id)
    expect((await app(request("/api/collector-status", collector.token, status("mac-a")))).status).toBe(401)
    expect((await app(request("/api/bootstrap", reader.token))).status).toBe(401)
    expect(db.sqlite.query("SELECT id FROM machines").get()).toEqual({ id: "mac-a" })
  })

  test("owner bootstrap is private, persistent, local-only, and rotation invalidates sessions", async () => {
    const db = database(join(root(), "hub.sqlite"))
    initializeOwner(db)
    const token = readPrivateFile(ownerTokenPath(db)).trim()
    expect(statSync(ownerTokenPath(db)).mode & 0o777).toBe(0o600)
    expect(credentialFor(db, token)?.role).toBe("owner")
    expect(() => revokeCredential(db, credentialFor(db, token)!.id)).toThrow("rotate-owner")
    expect(JSON.stringify(db.sqlite.query("SELECT * FROM hub_credentials").all())).not.toContain(token)
    initializeOwner(db)
    expect(readPrivateFile(ownerTokenPath(db)).trim()).toBe(token)
    const app = createApp({ db })
    const login = await app(request("/api/auth/login", undefined, { token }, { origin }))
    expect(login.status).toBe(204)
    expect(login.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=43200")
    const cookie = login.headers.get("set-cookie")!.split(";")[0]
    expect((await app(request("/api/bootstrap", undefined, undefined, { cookie }))).status).toBe(200)
    expect((await app(request("/api/pocket", undefined, { text: "no origin" }, { cookie }))).status).toBe(401)
    expect((await app(request("/api/pocket", undefined, { text: "owner" }, { cookie, origin }))).status).toBe(201)
    rotateOwner(db)
    expect((await app(request("/api/bootstrap", token))).status).toBe(401)
    expect((await app(request("/api/bootstrap", undefined, undefined, { cookie }))).status).toBe(401)
  })

  test("browser sessions expire, logout revokes them, and tailnet cookies stay Secure behind TLS termination", async () => {
    const db = database(), owner = issueCredential(db, "owner")
    let now = 1000
    const app = createApp({ db, now: () => now, trustedOrigins: [origin, "https://hub.example.ts.net"] })
    const login = () => app(request("/api/auth/login", undefined, { token: owner.token }, { origin }))
    let cookie = (await login()).headers.get("set-cookie")!.split(";")[0]
    expect((await app(request("/api/auth/logout", undefined, undefined, { cookie, origin }, "POST"))).status).toBe(204)
    expect((await app(request("/api/bootstrap", undefined, undefined, { cookie }))).status).toBe(401)
    cookie = (await login()).headers.get("set-cookie")!.split(";")[0]
    now += 12 * 60 * 60_000
    expect((await app(request("/api/bootstrap", undefined, undefined, { cookie }))).status).toBe(401)
    const response = await app(new Request("http://hub.example.ts.net/api/auth/login", {
      method: "POST", headers: { origin: "https://hub.example.ts.net", "content-type": "application/json" }, body: JSON.stringify({ token: owner.token }),
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get("set-cookie")).toStartWith("__Host-trails-session=")
    expect(response.headers.get("set-cookie")).toContain("; Secure")
    const explicitPort = await app(new Request("http://hub.example.ts.net:443/api/auth/login", {
      method: "POST", headers: { origin: "https://hub.example.ts.net", "content-type": "application/json" }, body: JSON.stringify({ token: owner.token }),
    }))
    expect(explicitPort.status).toBe(204)
    expect(explicitPort.headers.get("set-cookie")).toStartWith("__Host-trails-session=")
    expect(explicitPort.headers.get("set-cookie")).toContain("; Secure")
    expect((await app(request("/api/bootstrap", undefined, undefined, { cookie: response.headers.get("set-cookie")!.split(";")[0] }))).status).toBe(401)
    expect((await app(request("/api/auth/login", undefined, { token: owner.token }, { origin: "https://attacker.example" }))).status).toBe(403)
  })

  test("pairing export/import preserves existing identity and binds credentials to their hub", async () => {
    const directory = root(), dbPath = join(directory, "hub.sqlite"), pairing = join(directory, "pairing.json"), configPath = join(directory, "collector.json")
    const old = configureCollector({ server: origin, name: "Mac", path: configPath })
    runAuthCommand(["pair", "--db", dbPath, "--server", origin, "--output", pairing, "--device-id", old.deviceId])
    const config = importCollectorPairing(pairing, origin, configPath)
    expect(config.deviceId).toBe(old.deviceId)
    expect(config.token).toHaveLength(43)
    expect(statSync(configPath).mode & 0o777).toBe(0o600)
    expect(() => importCollectorPairing(pairing, "https://other.example", configPath)).toThrow()
    expect(configureCollector({ server: origin, path: configPath }).token).toBe(config.token)
    expect(configureCollector({ server: "https://other.example", path: configPath }).token).toBeUndefined()
    chmodSync(pairing, 0o644)
    expect(() => loadCollectorConfig(pairing)).toThrow()
    chmodSync(pairing, 0o600)
    symlinkSync(pairing, join(directory, "link.json"))
    expect(() => loadCollectorConfig(join(directory, "link.json"))).toThrow()
    writeFileSync(pairing, `{"token":"${config.token}" broken`, { mode: 0o600 })
    expect(() => loadCollectorConfig(pairing)).toThrow("collector configuration is invalid")
    try { loadCollectorConfig(pairing) } catch (error) { expect(String(error)).not.toContain(config.token!) }
  })

  test("collector sends its credential for ingest and status without persisting it in progress state", async () => {
    const directory = root(), db = database(), collector = issueCredential(db, "collector", "mac-a")
    const app = createApp({ db })
    mkdirSync(join(directory, "project"))
    const source = join(directory, "project/session.jsonl")
    writeFileSync(source, JSON.stringify({ type: "user", timestamp: "2026-09-16T12:00:00Z", cwd: "/tmp/project", message: { content: "Fixture" } }) + "\n" + JSON.stringify({ type: "assistant", timestamp: "2026-09-16T12:01:00Z", message: { content: "Done" } }) + "\n")
    const calls: string[] = []
    const statePath = join(directory, "state.json")
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      expect(req.headers.get("authorization")).toBe(`Bearer ${collector.token}`)
      expect(init?.redirect).toBe("error")
      calls.push(new URL(req.url).pathname)
      return app(req)
    }) as typeof fetch
    const options = { server: origin, deviceId: "mac-a", deviceName: "A", token: collector.token, statePath, roots: [{ source: "claude" as const, path: directory, layout: "project" as const, restored: false }], fetch: fetcher }
    const result = await Effect.runPromise(runCollection(options))
    expect(result.uploaded).toBe(1)
    expect(calls).toEqual(["/api/ingest", "/api/collector-status"])
    expect(readFileSync(statePath, "utf8")).not.toContain(collector.token)
    revokeCredential(db, collector.id)
    await expect(Effect.runPromise(runCollection(options))).rejects.toThrow("http_401")
  })

  test("reader credentials are distinct and cannot be sent to a different configured server", () => {
    const home = root(), db = database(join(home, "hub.sqlite"))
    // mkdir through the existing private config writer used by collector configuration.
    configureCollector({ server: origin, path: join(home, ".config/trails/collector.json") })
    runAuthCommand(["read", "--db", db.path, "--server", origin, "--output", join(home, ".config/trails/reader.json")])
    const token = readerToken(origin, home)!
    expect(credentialFor(db, token)?.role).toBe("read")
    expect(() => readerToken("https://other.example", home)).toThrow()
  })
})
