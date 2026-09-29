import assert from "node:assert/strict"
import { createServer, type ViteDevServer } from "vite"
import config from "../../vite.config"
import { createApp } from "../authenticated-app"
import { openDatabase } from "../../server/db"
import { localOrigins } from "../../server/request-boundary"

const db = openDatabase(":memory:")
let app: ReturnType<typeof createApp>
const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => app(request) })
let vite: ViteDevServer | undefined
try {
  vite = await createServer({
    ...config, configFile: false, logLevel: "silent",
    // This HTTP-only fixture does not load client modules or need dependency scanning.
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { ...config.server, port: 0, watch: null, hmr: false, proxy: {
      "/api": { ...config.server!.proxy!["/api"] as object, target: `http://127.0.0.1:${backend.port}` },
    } },
  })
  await vite.listen()
  const address = vite.httpServer!.address()
  if (!address || typeof address === "string") throw new Error("Vite did not bind TCP")
  const origin = `http://127.0.0.1:${address.port}`
  app = createApp({ db, trustedOrigins: [...localOrigins(backend.port!), ...localOrigins(address.port)] })
  for (const path of ["/", "/days/2026-09-16"]) {
    for (const method of ["GET", "HEAD"]) {
      const html = await fetch(origin + path, { method, headers: { accept: "text/html" } })
      assert.equal(html.status, 200)
      assert.equal(html.headers.get("content-security-policy"), "frame-ancestors 'none'")
      assert.equal(html.headers.get("x-frame-options"), "DENY")
      if (method === "GET") assert.match(await html.text(), /<html/)
    }
  }
  assert.equal((await fetch(origin + "/api/bootstrap")).status, 200)
  assert.equal((await fetch(origin + "/api/pocket", { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json",
  }, body: JSON.stringify({ text: "via Vite" }) })).status, 201)
  assert.equal((await fetch(origin + "/api/pocket", { method: "POST", headers: {
    origin: "http://attacker.example", "content-type": "application/json",
  }, body: JSON.stringify({ text: "blocked" }) })).status, 403)
  assert.equal((await fetch(origin + "/api/bootstrap", {
    headers: { host: "attacker.example", "x-forwarded-host": `localhost:${address.port}` },
  })).status, 403)
} finally {
  await vite?.close()
  await backend.stop(true)
  db.close()
}
