import { afterEach, describe, expect, test } from "bun:test"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import { localParts, workdayOf } from "../shared/domain"
import type { BootstrapV1, IngestRequestV1 } from "../shared/protocol"
import { createBootstrapRequester } from "../src/lib/api"

type App = (request: Request) => Promise<Response>
const databases = new Set<TrailsDb>()

afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
})

function memoryDatabase(): TrailsDb {
  const database = openDatabase(":memory:")
  databases.add(database)
  return database
}

function relativeRequest(app: App) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    app(new Request(new URL(String(input), "http://trails.test"), init))
}

function requireSnapshot(snapshot: BootstrapV1 | null): BootstrapV1 {
  if (snapshot === null) throw new Error("expected a loaded bootstrap snapshot")
  return snapshot
}

const ingest: IngestRequestV1 = {
  protocolVersion: 1,
  device: { id: "source-mac", name: "Source Mac" },
  sessions: [
    {
      sourceSessionId: "first-trail",
      source: "omp",
      cwd: "/Users/tester/code/acme/trails",
      branch: "feat/onboarding",
      start: "2026-07-01T12:29:00.000Z",
      end: "2026-07-01T12:30:00.000Z",
      events: 2,
      userEvents: 1,
      firstPrompt: "Make the first trail legible",
      activity: [["2026-07-01", 330, 2, 1]],
      digest: null,
    },
  ],
}

describe("onboarding bootstrap contract", () => {
  test("indexes accepted session changes at deterministic application time", async () => {
    const fixedTimestamp = "2026-07-01T12:30:00.000Z"
    const fixedNow = Date.parse(fixedTimestamp)
    const database = memoryDatabase()
    const app = createApp({ db: database, now: () => fixedNow })
    const request = relativeRequest(app)
    let snapshot: BootstrapV1 | null = null
    const requester = createBootstrapRequester({
      request,
      read: () => snapshot,
      write: (value) => {
        snapshot = value
      },
      setError: (error) => expect(error).toBeNull(),
      setLoading: () => {},
      isMounted: () => true,
    })

    await requester.fetch(false)
    expect(snapshot).toMatchObject({
      revision: 0,
      generatedAt: fixedTimestamp,
      indexedAt: null,
      sessions: [],
    })

    const ingestResponse = await request("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ingest),
    })
    expect(ingestResponse.status).toBe(200)

    await requester.fetch(true)
    expect(snapshot).toMatchObject({
      revision: 1,
      generatedAt: fixedTimestamp,
      indexedAt: fixedTimestamp,
    })
    const acceptedSnapshot = requireSnapshot(snapshot)
    expect(acceptedSnapshot.sessions).toHaveLength(1)
    await requester.fetch(true)
    expect(requireSnapshot(snapshot)).toBe(acceptedSnapshot)

    const settingsResponse = await request("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ boundary: 5 }),
    })
    expect(settingsResponse.status).toBe(200)
    expect(
      database.sqlite.query("SELECT boundary, available_at FROM day_summary_jobs WHERE boundary = 5").get(),
    ).toEqual({ boundary: 5, available_at: fixedNow })
  })

  test("derives cutoff workdays in the protocol timezone", () => {
    const parts = localParts("2026-07-01T12:30:00.000Z")
    expect(parts).toEqual({ date: "2026-07-01", minute: 330 })
    expect(workdayOf(parts!.date, parts!.minute, 6)).toBe("2026-06-30")
  })
})
