import { afterEach, describe, expect, test } from "bun:test"
import { File } from "node:buffer"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"

const roots: string[] = []
const databases: TrailsDb[] = []
const html = "<!doctype html><title>Trails framing fixture</title>"
const origins = ["http://127.0.0.1:7412", "https://hub.example.ts.net"]

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe("HTML framing policy", () => {
  for (const source of ["disk", "embedded"] as const) {
    test(`${source} HTML denies all ancestors for direct, fallback, GET, and HEAD responses`, async () => {
      const root = await mkdtemp(join(tmpdir(), "trails-frame-policy-"))
      roots.push(root)
      const db = openDatabase(":memory:")
      databases.push(db)
      const files = [
        new File([html], "index.html", { type: "text/html;charset=utf-8" }),
        new File([html], "help.html", { type: "text/html" }),
        new File(["body{}"], "plain.css", { type: "text/css" }),
      ]
      if (source === "disk") {
        for (const file of files) await writeFile(join(root, file.name), await file.text())
      }
      const app = createApp({
        db, staticRoot: root, trustedOrigins: origins,
        staticAssets: source === "embedded" ? files : undefined,
      })

      for (const origin of origins) {
        for (const path of ["/", "/index.html", "/days/2026-09-16", "/help.html"]) {
          for (const method of ["GET", "HEAD"]) {
            // Frame navigation can carry no Origin; write-origin checks are insufficient.
            const response = await app(new Request(origin + path, { method, headers: {
              "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate",
            } }))
            expect(response.status).toBe(200)
            expect(response.headers.get("content-type")).toStartWith("text/html")
            expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'")
            expect(response.headers.get("x-frame-options")).toBe("DENY")
            expect(response.headers.get("cache-control")).toBe(path === "/help.html" ? "no-cache" : "no-store")
            expect(await response.text()).toBe(method === "HEAD" ? "" : html)
            if (method === "HEAD") expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(html)))
          }
        }
        const css = await app(new Request(origin + "/plain.css"))
        expect(css.status).toBe(200)
        expect(css.headers.get("content-type")).toStartWith("text/css")
        expect(await css.text()).toBe("body{}")
        const health = await app(new Request(origin + "/api/health"))
        expect(health.status).toBe(200)
        expect(await health.json() as unknown).toEqual({ ok: true })
      }
    })
  }
})
