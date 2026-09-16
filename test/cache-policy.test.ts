import { afterEach, describe, expect, test } from "bun:test"
import { createApp } from "../server/app"
import { revokeCredential } from "../server/auth"
import { cacheFixture, cacheFixtureImage } from "./cache-fixture"

const fixtures: Awaited<ReturnType<typeof cacheFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture() {
  const value = await cacheFixture()
  fixtures.push(value)
  return value
}
const origin = "http://trails.test"
function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (token) headers.set("Authorization", `Bearer ${token}`)
  return new Request(origin + path, { ...init, headers })
}
function noStore(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get("cache-control")).toBe("no-store")
}

describe("private HTTP cache policy", () => {
  test("JSON, status, authentication, and error responses never permit storage", async () => {
    const { app, db, owner, reader, collector, revision } = await fixture()
    for (const path of ["/api/health", "/api/bootstrap", "/api/machines", "/api/harnesses", "/api/summarization", "/api/auth/session"]) {
      noStore(await app(request(path, owner.token)), 200)
    }
    noStore(await app(request(`/api/bootstrap?after=${revision}`, owner.token)), 204)
    for (const method of ["GET", "HEAD"]) {
      noStore(await app(request("/api/bootstrap", undefined, { method })), 401)
      noStore(await app(request("/api/bootstrap", collector.token, { method })), 403)
      noStore(await app(request("/api/missing", owner.token, { method })), 404)
      noStore(await app(request("/api/bootstrap", owner.token, { method, headers: { Host: "untrusted.test" } })), 403)
    }
    noStore(await app(request("/api/bootstrap", owner.token, { method: "HEAD" })), 405)
    noStore(await app(request("/api/bootstrap?after=invalid", owner.token)), 400)
    noStore(await app(request("/api/pocket", reader.token, { method: "POST" })), 403)
    noStore(await app(request("/api/pocket", owner.token, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    })), 400)
    noStore(await app(request("/api/pocket", owner.token, {
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "65537" }, body: "{}",
    })), 413)
    const broken = createApp({ db, trustedOrigins: [origin], summarization: { describe() { throw new Error("fixture failure") } } })
    noStore(await broken(request("/api/summarization", owner.token)), 500)

    const login = await app(request("/api/auth/login", undefined, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: owner.token }),
    }))
    noStore(login, 204)
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!
    noStore(await app(request("/api/auth/logout", undefined, {
      method: "POST", headers: { Cookie: cookie, Origin: origin },
    })), 204)
    noStore(await app(request("/api/bootstrap", undefined, { headers: { Cookie: cookie } })), 401)
  })

  test("images check permission and existence before GET/HEAD validators", async () => {
    const { app, db, reader, collector, imageUrl } = await fixture()
    expect(imageUrl).toMatch(/\?v=2-[0-9a-f]{64}$/)
    const image = await app(request(imageUrl, reader.token))
    noStore(image, 200)
    expect(Buffer.from(await image.arrayBuffer())).toEqual(cacheFixtureImage)
    // An old URL that reaches the server also gets the current no-store policy.
    noStore(await app(request(imageUrl.replace("?v=2-", "?v="), reader.token)), 200)
    const etag = image.headers.get("etag")!
    for (const method of ["GET", "HEAD"]) {
      for (const validator of [undefined, '"stale"', etag]) {
        const response = await app(request(imageUrl, reader.token, {
          method, headers: validator ? { "If-None-Match": validator } : {},
        }))
        noStore(response, validator === etag ? 304 : 200)
        expect(response.headers.get("etag")).toBe(etag)
        expect(response.headers.get("content-length")).toBe(String(cacheFixtureImage.length))
        if (method === "HEAD" || validator === etag) expect(await response.text()).toBe("")
      }
      const conditional = { method, headers: { "If-None-Match": etag } }
      noStore(await app(request(imageUrl, undefined, conditional)), 401)
      noStore(await app(request(imageUrl, collector.token, conditional)), 403)
      noStore(await app(request("/api/capture-images/999/0", reader.token, conditional)), 404)
      noStore(await app(request("/api/capture-images/invalid/0", reader.token, conditional)), 400)
    }
    db.sqlite.query("DELETE FROM capture_images").run()
    for (const method of ["GET", "HEAD"]) {
      noStore(await app(request(imageUrl, reader.token, { method, headers: { "If-None-Match": etag } })), 404)
    }
    revokeCredential(db, reader.id)
    for (const method of ["GET", "HEAD"]) {
      noStore(await app(request(imageUrl, reader.token, { method, headers: { "If-None-Match": etag } })), 401)
    }
  })

  test("only fingerprinted public assets have long-lived caching", async () => {
    const { app } = await fixture()
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/", "/days/example", "/missing-12345678.js"]) {
        noStore(await app(request(path, undefined, { method })), 200)
      }
      const asset = await app(request("/app-12345678.js", undefined, { method }))
      expect(asset.status).toBe(200)
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      const plain = await app(request("/plain.css", undefined, { method }))
      expect(plain.status).toBe(200)
      expect(plain.headers.get("cache-control")).toBe("no-cache")
      noStore(await app(request("/%00", undefined, { method })), 400)
      if (method === "HEAD") expect(await asset.text()).toBe("")
    }
  })
})
