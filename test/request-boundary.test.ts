import { afterEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import { localOrigins, normalizeTrustedOrigin } from "../server/request-boundary"

const databases: TrailsDb[] = []
const roots: string[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(trustedOrigins = [...localOrigins(7412), "https://hub.example.ts.net", "https://trails.example.ts.net"]) {
  const db = openDatabase(":memory:")
  databases.push(db)
  const activate = mock(() => {})
  const root = mkdtempSync(join(tmpdir(), "trails-boundary-"))
  roots.push(root)
  writeFileSync(join(root, "index.html"), "boundary fixture")
  const app = createApp({ db, trustedOrigins, staticRoot: root, harnesses: {
    activate, disconnect: mock(() => {}),
    status: () => ({ protocolVersion: 1, harnesses: [], active: null }),
  } })
  return { db, app, activate }
}

function mutation(url: string, headers: Record<string, string> = {}, body: unknown = { text: "fixture" }, method = "POST") {
  return new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
}

async function rejected(response: Response, code: string) {
  expect(response.status).toBe(403)
  expect(await response.json() as unknown).toEqual({ error: { code, message: "request origin or host is not trusted" } })
}

describe("HTTP request boundary", () => {
  test("rejects the audit's hostile authority before reads, static routing, writes, and harness activation", async () => {
    const { app, db, activate } = fixture()
    const base = "http://attacker.example:7412"
    for (const path of ["/api/bootstrap", "/", "/missing.js", "/api/unknown"]) {
      await rejected(await app(new Request(base + path)), "untrusted_host")
    }
    await rejected(await app(mutation(base + "/api/pocket", { origin: base })), "untrusted_host")
    await rejected(await app(mutation(base + "/api/summarizer", { origin: base }, { harness: "codex" })), "untrusted_host")
    expect(db.sqlite.query("SELECT count(*) AS count FROM pocket_items").get()).toEqual({ count: 0 })
    expect(activate).not.toHaveBeenCalled()
    expect(db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "0" })
  })

  test("accepts exact loopback, IPv6, node and named-service origins", async () => {
    const { app } = fixture()
    for (const origin of [...localOrigins(7412), "https://hub.example.ts.net", "https://trails.example.ts.net"]) {
      expect((await app(new Request(origin + "/api/bootstrap"))).status).toBe(200)
      expect((await app(mutation(origin + "/api/pocket", { origin, "sec-fetch-site": "same-origin" }))).status).toBe(201)
    }
    // TLS terminates at Tailscale; the upstream URL is HTTP with the original Host.
    expect((await app(mutation("http://hub.example.ts.net/api/pocket", {
      host: "hub.example.ts.net", origin: "https://hub.example.ts.net", "sec-fetch-site": "same-origin",
    }))).status).toBe(201)
    expect((await app(new Request("http://hub.example.ts.net:443/api/bootstrap", {
      headers: { host: "HUB.EXAMPLE.TS.NET:443" },
    }))).status).toBe(200)
  })

  test("does not trust suffixes, other ports, loopback ranges, trailing dots, or malformed Host", async () => {
    const { app } = fixture()
    for (const host of ["attacker.example:7412", "localhost:9999", "127.0.0.2:7412", "localhost.:7412",
      "hub.example.ts.net.attacker.example", "other.example.ts.net", "hub.example.ts.net:7412",
      "localhost:7412,attacker.example", "localhost:7412@attacker.example", "", "127.1:7412"]) {
      await rejected(await app(new Request("http://localhost:7412/api/bootstrap", { headers: { host } })), "untrusted_host")
    }
    await rejected(await app(new Request("http://attacker.example:7412/api/bootstrap", {
      headers: { host: "localhost:7412" },
    })), "untrusted_host")
    // Even two separately trusted authorities must agree between URL and Host.
    await rejected(await app(new Request("http://localhost:7412/api/bootstrap", {
      headers: { host: "hub.example.ts.net" },
    })), "untrusted_host")
  })

  test("rejects null, foreign, malformed, and different trusted origins on every mutation method", async () => {
    const { app, db } = fixture()
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const origin of ["null", "http://attacker.example", "http://localhost:7413", "https://localhost:7412",
        "http://127.0.0.1:7412", "https://hub.example.ts.net", "http://localhost:7412/", "",
        "http://localhost:7412 http://attacker.example", "http://localhost:7412@attacker.example"]) {
        await rejected(await app(mutation("http://localhost:7412/api/pocket", { origin }, undefined, method)), "untrusted_origin")
      }
    }
    expect(db.sqlite.query("SELECT count(*) AS count FROM pocket_items").get()).toEqual({ count: 0 })
  })

  test("rejects cross-site, same-site, none and missing-origin browser mutations", async () => {
    const { app } = fixture()
    for (const site of ["cross-site", "same-site", "none", "invalid", ""]) {
      const cases: Record<string, string>[] = [{ "sec-fetch-site": site }, { "sec-fetch-site": site, origin: "http://localhost:7412" }]
      for (const headers of cases) {
        await rejected(await app(mutation("http://localhost:7412/api/pocket", headers)), "untrusted_origin")
      }
    }
    const missingOrigin: Record<string, string>[] = [{ "sec-fetch-site": "same-origin" }, { "sec-fetch-mode": "no-cors" }, { "sec-fetch-dest": "empty" }]
    for (const headers of missingOrigin) {
      await rejected(await app(mutation("http://localhost:7412/api/pocket", headers)), "untrusted_origin")
    }
    expect((await app(mutation("http://localhost:7412/api/pocket", { origin: "http://localhost:7412" }))).status).toBe(201)
  })

  test("ignores forged forwarding headers and never uses them to repair Host or Origin", async () => {
    const { app } = fixture()
    const headers = {
      forwarded: 'host="localhost:7412";proto=http', "x-forwarded-host": "localhost:7412",
      "x-forwarded-proto": "http", "x-forwarded-port": "7412", "x-original-host": "localhost:7412",
    }
    await rejected(await app(new Request("http://attacker.example:7412/api/bootstrap", { headers })), "untrusted_host")
    await rejected(await app(mutation("http://localhost:7412/api/pocket", {
      ...headers, origin: "https://hub.example.ts.net", "x-forwarded-host": "hub.example.ts.net", "x-forwarded-proto": "https",
    })), "untrusted_origin")
    expect((await app(mutation("http://localhost:7412/api/pocket", {
      origin: "http://localhost:7412", "x-forwarded-host": "attacker.example", "x-forwarded-proto": "https",
    }))).status).toBe(201)
  })

  test("preserves native collector status requests with and without an Authorization header", async () => {
    const { app, db } = fixture()
    const nativeHeaders: Record<string, string>[] = [{}, { authorization: "Bearer synthetic-collector-token" }]
    for (const headers of nativeHeaders) {
      expect((await app(mutation("https://hub.example.ts.net/api/collector-status", headers, {
        protocolVersion: 1, device: { id: "native-collector", name: "Fixture" },
        outcome: { status: "failed", metrics: null, error: "collector_error" },
      }))).status).toBe(204)
    }
    expect(db.sqlite.query("SELECT id FROM machines").get()).toEqual({ id: "native-collector" })
    await rejected(await app(mutation("https://hub.example.ts.net/api/pocket", {
      authorization: "Bearer synthetic-collector-token", origin: "null",
    })), "untrusted_origin")
  })

  test("checks real HTTP Host before routing on a custom local port", async () => {
    let app: ReturnType<typeof createApp>
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app(request) })
    try {
      app = fixture([...localOrigins(server.port!), "https://hub.example.ts.net"]).app
      const base = `http://127.0.0.1:${server.port}`
      expect((await fetch(base + "/api/bootstrap")).status).toBe(200)
      await rejected(await fetch(base + "/api/bootstrap", { headers: {
        host: "attacker.example:7412", "x-forwarded-host": `localhost:${server.port}`,
      } }), "untrusted_host")
      expect((await fetch(base + "/api/pocket", { method: "POST", headers: {
        host: "hub.example.ts.net", origin: "https://hub.example.ts.net", "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      }, body: JSON.stringify({ text: "through proxy" }) })).status).toBe(201)
      await rejected(await fetch(base + "/api/pocket", { method: "POST", headers: {
        origin: "null", "content-type": "application/json",
      }, body: JSON.stringify({ text: "blocked" }) }), "untrusted_origin")
    } finally {
      await server.stop(true)
    }
  })

  test("default app trusts only local port 7412 and validates configuration eagerly", async () => {
    const db = openDatabase(":memory:")
    databases.push(db)
    const app = createApp({ db })
    expect((await app(new Request("http://localhost:7412/api/bootstrap"))).status).toBe(200)
    await rejected(await app(new Request("http://localhost:7413/api/bootstrap")), "untrusted_host")
    for (const origin of ["*", "https://*.ts.net", "null", "file:///tmp", "https://user:pass@host", "https://host/path",
      "https://host?query", "https://host#fragment", "https://host:99999", "https://host\\path"]) {
      expect(() => createApp({ db, trustedOrigins: [origin] })).toThrow()
    }
    expect(normalizeTrustedOrigin("https://HUB.EXAMPLE.TS.NET:443/")).toBe("https://hub.example.ts.net")
  })
})
