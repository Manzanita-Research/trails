import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMidjourneyCommand } from "../cli/midjourney"
import {
  MidjourneyAdapter,
  collectMidjourneyFeed,
  decodeMidjourneyCursor,
  downloadMidjourneyImages,
  encodeMidjourneyCursor,
  reduceMidjourneyBrowserCapture,
  type MidjourneyBrowserCapture,
  type MidjourneyBrowserBridge,
  type MidjourneyJob,
} from "../collector/midjourney"
import { loadCollectorState, saveCollectorState } from "../collector/state"
import { IngestCapturesRequestV1Schema, decodeExact } from "../shared/protocol"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "trails-midjourney-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const webpBytes = Buffer.from([
  0x52, 0x49, 0x46, 0x46,
  0x08, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20,
])

function rawJob(id: string, enqueueTime: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    enqueue_time: enqueueTime,
    event_type: "imagine",
    job_type: "generation",
    parent_id: null,
    parent_grid: null,
    width: 1024,
    height: 768,
    full_command: `Synthetic prompt ${id}`,
    account_id: "must-be-stripped",
    email: "private@example.com",
    authorization: "secret",
    ...overrides,
  }
}

function browserCapture(
  jobs: ReadonlyArray<unknown>,
  overrides: Partial<MidjourneyBrowserCapture> = {},
): MidjourneyBrowserCapture {
  return {
    authenticated: true,
    imagineBodies: [{ jobs }],
    folderBodies: [],
    saturated: false,
    ...overrides,
  }
}

function successfulImageFetch(urls: string[] = []) {
  return async (input: URL | string | Request): Promise<Response> => {
    const url = String(input)
    urls.push(url)
    return new Response(webpBytes, { headers: { "Content-Type": "image/webp" } })
  }
}

function normalizedJob(): MidjourneyJob {
  return {
    id: "job-1",
    enqueueTime: "2026-08-03T17:00:00.000Z",
    eventType: "imagine",
    jobType: "generation",
    parentId: null,
    parentGrid: null,
    width: 1024,
    height: 768,
    fullCommand: "Synthetic prompt",
  }
}

class FakeBrowser implements MidjourneyBrowserBridge {
  constructor(private readonly value: MidjourneyBrowserCapture | Error) {}

  async capture(): Promise<MidjourneyBrowserCapture> {
    if (this.value instanceof Error) throw this.value
    return this.value
  }
}

describe("Midjourney response reduction", () => {
  test("normalizes new generations and variations in cursor order while stripping account fields", async () => {
    const urls: string[] = []
    const capture = browserCapture(
      [
        rawJob("variation-1", "2026-08-03T17:01:00Z", {
          event_type: "variation",
          job_type: "variation",
          parent_id: "job-1",
          parent_grid: 2,
        }),
        rawJob("job-1", "2026-08-03T17:00:00Z"),
      ],
      {
        folderBodies: [{ folders: [{ title: "Research", images: [{ id: "job-1", index: 0 }] }] }],
      },
    )
    const result = await collectMidjourneyFeed(capture, null, {
      since: "2026-08-03T16:59:00.000Z",
      fetch: successfulImageFetch(urls),
    })

    expect(result.captures.map((item) => item.sourceRecordId)).toEqual(["job-1", "variation-1"])
    expect(result.captures[0]).toMatchObject({
      project: null,
      projectHint: "Research",
      startedAt: "2026-08-03T17:00:00.000Z",
      attentionMinutes: [Math.floor(Date.parse("2026-08-03T17:00:00.000Z") / 60_000)],
      images: [
        { index: 0, mime: "image/webp", width: 1024, height: 768 },
        { index: 1, mime: "image/webp", width: 1024, height: 768 },
        { index: 2, mime: "image/webp", width: 1024, height: 768 },
        { index: 3, mime: "image/webp", width: 1024, height: 768 },
      ],
    })
    expect(result.captures[1]).toMatchObject({
      projectHint: null,
      payload: { parentSourceRecordId: "job-1", parentGrid: 2 },
    })
    expect(urls).toEqual([
      "https://cdn.midjourney.com/job-1/0_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/job-1/1_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/job-1/2_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/job-1/3_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/variation-1/0_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/variation-1/1_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/variation-1/2_640_N.webp?method=shortest",
      "https://cdn.midjourney.com/variation-1/3_640_N.webp?method=shortest",
    ])
    expect(decodeMidjourneyCursor(result.nextCursor!)).toEqual({
      enqueueTime: "2026-08-03T17:01:00.000Z",
      id: "variation-1",
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("must-be-stripped")
    expect(serialized).not.toContain("private@example.com")
    expect(serialized).not.toContain("authorization")
  })

  test("preserves the repair cursor for immediate named jobs", async () => {
    const cursor = encodeMidjourneyCursor({ enqueueTime: "2026-08-03T16:00:00.000Z", id: "earlier" })
    const result = await collectMidjourneyFeed(
      browserCapture([rawJob("job-1", "2026-08-03T17:00:00.000Z")]),
      cursor,
      {
        jobs: ["job-1"],
        project: "/Users/tester/code/acme/project",
        fetch: successfulImageFetch(),
      },
    )
    expect(result.captures).toHaveLength(1)
    expect(result.captures[0]?.project).toBe("/Users/tester/code/acme/project")
    expect(result.nextCursor).toBe(cursor)
  })

  test("requires a first-run since anchor and refuses incomplete saturated history", async () => {
    const capture = browserCapture([rawJob("job-1", "2026-08-03T17:00:00.000Z")])
    await expect(collectMidjourneyFeed(capture, null, { fetch: successfulImageFetch() })).rejects.toThrow("--since")
    await expect(
      collectMidjourneyFeed({ ...capture, saturated: true }, null, {
        since: "2026-08-03T16:00:00.000Z",
        fetch: successfulImageFetch(),
      }),
    ).rejects.toThrow("history window is incomplete")
  })

  test("uploads the oldest fifty eligible jobs and cannot jump over a backlog", async () => {
    const jobs = Array.from({ length: 55 }, (_, index) =>
      rawJob(`job-${String(index).padStart(2, "0")}`, `2026-08-03T17:${String(index).padStart(2, "0")}:00.000Z`),
    )
    const result = await collectMidjourneyFeed(browserCapture(jobs.reverse()), null, {
      since: "2026-08-03T16:59:00.000Z",
      limit: 50,
      fetch: successfulImageFetch(),
    })
    expect(result.captures).toHaveLength(50)
    expect(result.captures[0]?.sourceRecordId).toBe("job-00")
    expect(result.captures.at(-1)?.sourceRecordId).toBe("job-49")
    expect(decodeMidjourneyCursor(result.nextCursor!).id).toBe("job-49")
  })

  test("fails closed on login, control, missing jobs, and response-shape drift", async () => {
    expect(() => reduceMidjourneyBrowserCapture(browserCapture([], { authenticated: false }))).toThrow(
      "not authenticated",
    )
    expect(() => reduceMidjourneyBrowserCapture({ ...browserCapture([]), imagineBodies: [{ unknown: [] }] })).toThrow(
      "shape changed",
    )
    await expect(
      collectMidjourneyFeed(browserCapture([rawJob("job-1", "2026-08-03T17:00:00.000Z")]), null, {
        jobs: ["missing"],
        project: "/tmp/project",
        fetch: successfulImageFetch(),
      }),
    ).rejects.toThrow("did not appear")
    await expect(
      new MidjourneyAdapter({
        jobs: ["job-1"],
        project: "/tmp/project",
        browser: new FakeBrowser(new Error("user is controlling the task space")),
      }).collect(null),
    ).rejects.toThrow("user is controlling")
  })
})

describe("Midjourney image boundary", () => {
  test("rejects the wrong CDN host, MIME, magic, and decoded size", async () => {
    const wrongHost = async () => {
      const response = new Response(webpBytes, { headers: { "Content-Type": "image/webp" } })
      Object.defineProperty(response, "url", { value: "https://example.com/image.webp" })
      return response
    }
    await expect(downloadMidjourneyImages(normalizedJob(), wrongHost)).rejects.toThrow("outside the approved CDN")
    await expect(
      downloadMidjourneyImages(
        normalizedJob(),
        async () => new Response(webpBytes, { headers: { "Content-Type": "image/png" } }),
      ),
    ).rejects.toThrow("not WebP")
    await expect(
      downloadMidjourneyImages(
        normalizedJob(),
        async () => new Response(Buffer.from("not webp"), { headers: { "Content-Type": "image/webp" } }),
      ),
    ).rejects.toThrow("invalid WebP")
    const oversized = Buffer.alloc(500 * 1024 + 1)
    webpBytes.copy(oversized, 0)
    await expect(
      downloadMidjourneyImages(
        normalizedJob(),
        async () => new Response(oversized, { headers: { "Content-Type": "image/webp" } }),
      ),
    ).rejects.toThrow("exceeds 500 KiB")
  })
})

describe("Midjourney CLI handoff", () => {
  test("dry-run reports only facts and never uploads or mutates state", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector.json")
    const target = { server: "http://127.0.0.1:7412/", deviceId: "device-1", deviceName: "Laptop" }
    const cursor = encodeMidjourneyCursor({ enqueueTime: "2026-08-03T16:00:00.000Z", id: "earlier" })
    await Effect.runPromise(
      saveCollectorState(statePath, {
        protocolVersion: 3,
        target,
        files: { "/tmp/session.jsonl": { size: 1, mtimeMs: 2 } },
        captureCursors: { midjourney: cursor, granola: "granola-cursor" },
      }),
    )
    const before = await readFile(statePath, "utf8")
    const output: string[] = []
    let imageFetches = 0
    await runMidjourneyCommand(
      [
        "--job", "job-1",
        "--project", "/tmp/project",
        "--dry-run",
        "--server", target.server,
        "--device-id", target.deviceId,
        "--device-name", target.deviceName,
        "--state", statePath,
      ],
      {
        loadConfig: () => null,
        browser: new FakeBrowser(browserCapture([rawJob("job-1", "2026-08-03T17:00:00.000Z")])),
        fetch: async () => {
          imageFetches++
          return new Response(webpBytes, { headers: { "Content-Type": "image/webp" } })
        },
        output: (message) => output.push(message),
      },
    )
    expect(imageFetches).toBe(4)
    expect(await readFile(statePath, "utf8")).toBe(before)
    expect(output).toEqual(["midjourney dry run: source midjourney; captures 1; images 4; cursor unchanged"])
    expect(output[0]).not.toContain("job-1")
    expect(output[0]).not.toContain("http")
    expect(output[0]).not.toContain("Synthetic prompt")
  })

  test("hands validated captures to the generic upload runner", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector.json")
    const target = { server: "http://127.0.0.1:7412/", deviceId: "device-1", deviceName: "Laptop" }
    const uploads: unknown[] = []
    const output: string[] = []
    await runMidjourneyCommand(
      [
        "--job", "job-1",
        "--project", "/tmp/project",
        "--server", target.server,
        "--device-id", target.deviceId,
        "--device-name", target.deviceName,
        "--state", statePath,
      ],
      {
        loadConfig: () => null,
        browser: new FakeBrowser(browserCapture([rawJob("job-1", "2026-08-03T17:00:00.000Z")])),
        fetch: async (input, init) => {
          const url = new URL(String(input))
          if (url.hostname === "cdn.midjourney.com") {
            return new Response(webpBytes, { headers: { "Content-Type": "image/webp" } })
          }
          const body = decodeExact(IngestCapturesRequestV1Schema, JSON.parse(String(init?.body)))
          uploads.push(body)
          return Response.json({ accepted: body.captures.length, unchanged: 0, revision: 1 })
        },
        output: (message) => output.push(message),
      },
    )
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({
      device: { id: "device-1", name: "Laptop" },
      captures: [{ source: "midjourney", sourceRecordId: "job-1", project: "/tmp/project", images: expect.any(Array) }],
    })
    expect((await Effect.runPromise(loadCollectorState(statePath)))!.captureCursors.midjourney).toBeNull()
    expect(output).toEqual(["captured 1 Midjourney generation; cursor unchanged"])
  })
})
