import { describe, expect, test } from "bun:test"
import type { BootstrapV1 } from "../shared/protocol"
import { createBootstrapRequester, fetchMachines, fetchSummarization } from "../src/lib/api"

function bootstrap(revision: number): BootstrapV1 {
  return {
    protocolVersion: 1,
    revision,
    generatedAt: "2026-08-03T12:00:00.000Z",
    indexedAt: null,
    hubUrl: "http://127.0.0.1:7412/",
    timezone: "America/Los_Angeles",
    sessions: [],
    captures: [],
    summaries: { sessions: {}, days: {} },
    preferences: {
      boundary: 6,
      halo: 10,
      onboardingVersion: 0,
      assignments: {},
      customEngagements: [],
      names: {},
      pocket: [],
    },
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("bootstrap request ordering", () => {
  test("a late initial response cannot replace a newer poll", async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const pending = [first.promise, second.promise]
    const paths: string[] = []
    let data: BootstrapV1 | null = null
    const applied: BootstrapV1[] = []
    let error: string | null = "starting"
    let loading = true
    const requester = createBootstrapRequester({
      request: (input) => {
        paths.push(String(input))
        const response = pending.shift()
        if (!response) throw new Error("unexpected request")
        return response
      },
      read: () => data,
      write: (payload) => {
        data = payload
        applied.push(payload)
      },
      setError: (message) => {
        error = message
      },
      setLoading: (value) => {
        loading = value
      },
      isMounted: () => true,
    })

    const initial = requester.fetch(false)
    const poll = requester.fetch(true)
    second.resolve(Response.json(bootstrap(2)))
    await poll
    first.resolve(Response.json(bootstrap(1)))
    await initial

    expect(paths).toEqual(["/api/bootstrap", "/api/bootstrap"])
    expect(applied.map((payload) => payload.revision)).toEqual([2])
    expect(error).toBeNull()
    expect(loading).toBeFalse()
  })

  test("incremental 204 keeps the loaded snapshot and clears stale errors", async () => {
    const paths: string[] = []
    const loaded = bootstrap(7)
    let data: BootstrapV1 | null = loaded
    let error: string | null = "network unavailable"
    const requester = createBootstrapRequester({
      request: async (input) => {
        paths.push(String(input))
        return new Response(null, { status: 204 })
      },
      read: () => data,
      write: (payload) => {
        data = payload
      },
      setError: (message) => {
        error = message
      },
      setLoading: () => {},
      isMounted: () => true,
    })

    await requester.fetch(true)

    expect(paths).toEqual(["/api/bootstrap?after=7"])
    expect(data).toBe(loaded)
    expect(error).toBeNull()
  })

  test("a failed refresh reports the error without discarding the snapshot", async () => {
    const loaded = bootstrap(4)
    let data: BootstrapV1 | null = loaded
    const errors: Array<string | null> = []
    const requester = createBootstrapRequester({
      request: async () => {
        throw new Error("Hub unavailable")
      },
      read: () => data,
      write: (payload) => {
        data = payload
      },
      setError: (message) => {
        errors.push(message)
      },
      setLoading: () => {},
      isMounted: () => true,
    })

    await requester.fetch(true)

    expect(data).toBe(loaded)
    expect(errors).toEqual(["Hub unavailable"])
  })
})

describe("settings metadata queries", () => {
  test("exact-decodes machines and summarization responses", async () => {
    const paths: string[] = []
    const request = async (input: RequestInfo | URL): Promise<Response> => {
      paths.push(String(input))
      if (String(input) === "/api/machines") {
        return Response.json({
          protocolVersion: 1,
          generatedAt: "2026-08-04T12:00:00.000Z",
          machines: [],
        })
      }
      return Response.json({ enabled: false, metadata: null })
    }
    expect(await fetchMachines(request)).toEqual({
      protocolVersion: 1,
      generatedAt: "2026-08-04T12:00:00.000Z",
      machines: [],
    })
    expect(await fetchSummarization(request)).toEqual({ enabled: false, metadata: null })
    expect(paths).toEqual(["/api/machines", "/api/summarization"])
  })

  test("rejects non-exact and failed settings metadata responses", async () => {
    await expect(
      fetchMachines(async () =>
        Response.json({
          protocolVersion: 1,
          generatedAt: "2026-08-04T12:00:00.000Z",
          machines: [],
          online: true,
        }),
      ),
    ).rejects.toBeInstanceOf(Error)
    await expect(
      fetchSummarization(async () =>
        Response.json(
          {
            error: {
              code: "upstream_unavailable",
              message: "summarization metadata unavailable",
            },
          },
          { status: 502 },
        ),
      ),
    ).rejects.toThrow("summarization metadata unavailable")
  })
})
