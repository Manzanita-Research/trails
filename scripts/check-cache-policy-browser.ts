import assert from "node:assert/strict"
import { cacheFixture, cacheFixtureImage } from "../test/cache-fixture"

// Reuse a local Playwright module/browser; do not install or download dependencies.
const modulePath = process.env.PLAYWRIGHT_MODULE || "playwright"
const { chromium } = await import(modulePath)
let fixture: Awaited<ReturnType<typeof cacheFixture>> | undefined
const requests: Array<{ method: string; path: string; status: number; cacheControl: string | null }> = []
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    if (!fixture) return new Response(null, { status: 503 })
    const path = new URL(request.url).pathname + new URL(request.url).search
    // Simulate an entry served by the old release before this policy was installed.
    const legacyUrl = fixture.imageUrl.replace("?v=2-", "?v=")
    const response = path === legacyUrl
      ? new Response(cacheFixtureImage, { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" } })
      : await fixture.app(request)
    requests.push({ method: request.method, path, status: response.status, cacheControl: response.headers.get("cache-control") })
    return response
  },
})
let browser
try {
  fixture = await cacheFixture(server.url.origin)
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ serviceWorkers: "block" })
  context.setDefaultTimeout(10_000)
  const page = await context.newPage()
  // No request routing, DevTools cache disabling, or fetch cache overrides.
  await page.goto(server.url.origin)
  const get = (path: string, init: RequestInit = {}) => page.evaluate(async ({ path, init }: { path: string; init: RequestInit }) => {
    const response = await fetch(path, init)
    return { status: response.status, cache: response.headers.get("cache-control"), etag: response.headers.get("etag"), body: await response.text() }
  }, { path, init })
  const count = (path: string) => requests.filter(request => request.path === path).length
  const noStore = (response: { status: number; cache: string | null }, status = 200) => {
    assert.equal(response.status, status)
    assert.equal(response.cache, "no-store")
  }
  const login = async () => noStore(await get("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: fixture!.owner.token }),
  }), 204)
  await login()
  const { imageUrl, revision } = fixture
  const legacyUrl = imageUrl.replace("?v=2-", "?v=")
  assert.notEqual(imageUrl, legacyUrl)
  for (let attempt = 0; attempt < 2; attempt++) {
    noStore(await get("/api/bootstrap"))
    noStore(await get(imageUrl))
    assert.equal((await get(legacyUrl)).status, 200)
    assert.equal((await get("/app-12345678.js")).cache, "public, max-age=31536000, immutable")
  }
  assert.equal(count("/api/bootstrap"), 2)
  assert.equal(count(imageUrl), 2)
  assert.equal(count(legacyUrl), 1)
  assert.equal(count("/app-12345678.js"), 1)
  noStore(await get(`/api/bootstrap?after=${revision}`), 204)
  const image = await get(imageUrl)
  for (const method of ["GET", "HEAD"]) {
    const response = await get(imageUrl, { method, headers: { "If-None-Match": image.etag! } })
    noStore(response, 304)
    assert.equal(response.body, "")
  }
  const head = await get(imageUrl, { method: "HEAD" })
  noStore(head)
  assert.equal(head.body, "")
  const renderImage = () => page.evaluate(async (path: string) => {
    const image = new Image()
    image.src = path
    document.body.appendChild(image)
    try { await image.decode(); return image.naturalWidth } catch { return 0 }
    finally { image.remove() }
  }, imageUrl)
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.goto(server.url.origin)
    const before = count(imageUrl)
    assert.equal(await renderImage(), 1)
    assert.equal(count(imageUrl), before + 1)
  }

  await context.setOffline(true)
  for (const path of ["/api/bootstrap", imageUrl]) {
    assert.equal(await page.evaluate(async (path: string) => {
      try { await fetch(path); return "unexpected cached response" } catch { return "network failure" }
    }, path), "network failure")
  }
  assert.equal((await get("/app-12345678.js")).status, 200)
  assert.equal((await get(legacyUrl)).status, 200)
  await context.setOffline(false)

  noStore(await get("/api/auth/logout", { method: "POST" }), 204)
  for (const method of ["GET", "HEAD"]) {
    for (const path of ["/api/bootstrap", imageUrl]) {
      const response = await get(path, { method, headers: { "If-None-Match": image.etag! } })
      noStore(response, 401)
      if (method === "HEAD") assert.equal(response.body, "")
    }
  }
  await page.goto(server.url.origin)
  assert.equal(await renderImage(), 0)
  await login()
  fixture.db.sqlite.query("DELETE FROM capture_images").run()
  for (const method of ["GET", "HEAD"]) {
    const response = await get(imageUrl, { method, headers: { "If-None-Match": image.etag! } })
    noStore(response, 404)
    if (method === "HEAD") assert.equal(response.body, "")
  }
  await page.goto(server.url.origin)
  assert.equal(await renderImage(), 0)
  noStore(await get("/api/capture-images/invalid/0"), 400)
  noStore(await get(imageUrl, { method: "POST" }), 405)
  console.log(JSON.stringify({
    result: "pass", browser: await browser.version(),
    checks: ["repeated JSON and image requests reach server", "GET/HEAD/304 carry no-store", "image elements load through server in fresh documents",
      "private data unavailable offline", "logout returns 401, including conditional HEAD", "deleted images return 404, including conditional HEAD",
      "error responses carry no-store", "legacy immutable URL bypassed", "public fingerprinted asset reused online and offline"],
    requests,
  }, null, 2))
} finally {
  await browser?.close()
  await server.stop(true)
  await fixture?.close()
}
