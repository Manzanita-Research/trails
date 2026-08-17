import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureResponse } from "../plugins/herdr-trails/dev/fixture"
import { renderDashboard, type ViewState } from "../plugins/herdr-trails/src/render"
import {
  buildModel,
  fetchSnapshot,
  normalizeServerUrl,
  resolveServer,
} from "../plugins/herdr-trails/src/trails"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "trails-herdr-test-"))
  temporaryDirectories.push(path)
  return path
}

const state = (screen: ViewState["screen"]): ViewState => ({
  screen,
  selected: { days: 0, week: 0, threads: 0, status: 0 },
  detail: false,
  help: false,
  loading: false,
  error: null,
})

describe("Trails Herdr plugin", () => {
  test("uses the existing collector URL without rewriting its config", () => {
    const directory = temporaryDirectory()
    const collectorPath = join(directory, "collector.json")
    const config = JSON.stringify({
      protocolVersion: 1,
      server: "https://trails.example.ts.net/",
      deviceId: "device-1",
      deviceName: "Laptop",
    }, null, 2)
    writeFileSync(collectorPath, config)

    const resolution = resolveServer({ TRAILS_COLLECTOR_CONFIG_PATH: collectorPath }, directory)

    expect(resolution).toEqual({ url: "https://trails.example.ts.net/", source: "Trails collector" })
    expect(readFileSync(collectorPath, "utf8")).toBe(config)
  })

  test("keeps fixture overrides isolated from collector discovery", () => {
    const directory = temporaryDirectory()
    const resolution = resolveServer({
      TRAILS_HERDR_SERVER_URL: "http://127.0.0.1:7414/",
      TRAILS_COLLECTOR_CONFIG_PATH: join(directory, "missing.json"),
    }, directory)

    expect(resolution).toEqual({ url: "http://127.0.0.1:7414/", source: "environment" })
  })

  test("rejects credentialed and non-TLS remote URLs", () => {
    expect(() => normalizeServerUrl("https://person:secret@example.com/")).toThrow("credential-free")
    expect(() => normalizeServerUrl("http://trails.example.com/")).toThrow("requires HTTPS")
    expect(normalizeServerUrl("http://localhost:7412/")).toBe("http://localhost:7412/")
  })

  test("fetches the current API contract and builds day and thread views", async () => {
    const snapshot = await fetchSnapshot("http://127.0.0.1:7414/", {
      fetch: async (input) => fixtureResponse(new Request(input)),
      now: () => Date.parse("2026-08-17T18:30:00.000Z"),
    })
    const model = buildModel(snapshot.bootstrap)

    expect(snapshot.warnings).toEqual([])
    expect(model.days.map((day) => day.date)).toEqual(["2026-08-17", "2026-08-16", "2026-08-15"])
    expect(model.days[0].projects.map((project) => project.name)).toContain("Trails")
    expect(model.threads.map((thread) => thread.name)).toEqual(["Sign-on", "Trails", "Graze"])
  })

  test("renders terminal-native days and health views within the pane", async () => {
    const snapshot = await fetchSnapshot("http://127.0.0.1:7414/", {
      fetch: async (input) => fixtureResponse(new Request(input)),
      now: () => Date.parse("2026-08-17T18:30:00.000Z"),
    })
    const resolution = { url: "http://127.0.0.1:7414/", source: "environment" } as const
    const days = renderDashboard({ snapshot, resolution, state: state("days"), width: 100, height: 24, colors: false })
    const status = renderDashboard({
      snapshot,
      resolution,
      state: state("status"),
      width: 100,
      height: 24,
      now: Date.parse("2026-08-17T18:30:00.000Z"),
      colors: false,
    })

    expect(days).toContain("TRAILS")
    expect(days).toContain("Trails, Sign-on")
    expect(status).toContain("Collectors")
    expect(status).toContain("MacBook")
    expect(status).toContain("omp · ok")
    expect(days.split("\n")).toHaveLength(24)
    expect(days.split("\n").every((line) => line.length <= 100)).toBe(true)
  })
})
