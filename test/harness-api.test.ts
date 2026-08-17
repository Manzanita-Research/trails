import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadHubConfig } from "../cli/config"
import type { HarnessId } from "../shared/harnesses"
import { createApp } from "../server/app"
import { createHarnessControl } from "../server/harnesses/control"
import { createSummarizerManager } from "../server/harnesses/manager"
import { openDatabase, type TrailsDb } from "../server/db"

const roots: string[] = []
const databases = new Set<TrailsDb>()

afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function jsonRequest(url: string, value: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  })
}

describe("harness API", () => {
  test("reports path-free availability and persists explicit activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-harness-api-"))
    roots.push(root)
    const configPath = join(root, "server.json")
    const resolver = (id: HarnessId) => id === "omp" ? "/private/bin/omp" : null
    const manager = createSummarizerManager({ configPath, resolver })
    const harnesses = createHarnessControl({ manager, configPath, resolver })
    const database = openDatabase(":memory:")
    databases.add(database)
    const app = createApp({ db: database, summarization: manager, harnesses })

    let response = await app(new Request("https://hub.test/api/harnesses"))
    expect(response.status).toBe(200)
    const statusText = await response.text()
    expect(statusText).not.toContain("/private/bin/omp")
    const status = JSON.parse(statusText) as { active: unknown; harnesses: Array<{ id: string; available: boolean }> }
    expect(status.active).toBeNull()
    expect(status.harnesses.find((item) => item.id === "omp")?.available).toBe(true)

    response = await app(jsonRequest("https://hub.test/api/summarizer", { harness: "auto" }))
    expect(response.status).toBe(200)
    expect(loadHubConfig(configPath)).toEqual({ summarizer: { harness: "auto" } })

    response = await app(jsonRequest("https://hub.test/api/summarizer", { harness: "claude" }))
    expect(response.status).toBe(400)
    expect(loadHubConfig(configPath)).toEqual({ summarizer: { harness: "auto" } })

    response = await app(jsonRequest("https://hub.test/api/summarizer", null))
    expect(response.status).toBe(200)
    expect(loadHubConfig(configPath)).toEqual({ summarizer: null })
  })

  test("old provider routes are gone", async () => {
    const database = openDatabase(":memory:")
    databases.add(database)
    const app = createApp({ db: database })
    expect((await app(new Request("https://hub.test/api/connectors"))).status).toBe(404)
    expect((await app(new Request("https://hub.test/api/connect/openrouter/start", { method: "POST" }))).status).toBe(404)
  })
})
