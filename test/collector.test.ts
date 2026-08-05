import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CollectorError, runCollection } from "../collector/sync"
import {
  CollectorBusyError,
  loadCollectorState,
  saveCollectorState,
  withCollectorLock,
  type CollectorState,
} from "../collector/state"
import { discoverSourceFiles, parseSourceRoot, type SourceRoot } from "../collector/sources"
import { CollectorStatusV1Schema, IngestRequestV2Schema, decodeExact } from "../shared/protocol"

const temporaryDirectories: string[] = []
const servers: Bun.Server<undefined>[] = []
const collectorStatuses: unknown[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  collectorStatuses.splice(0)
})

async function temporaryDirectory(prefix = "trails-collector-test-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function writeClaudeSession(root: string, name: string, prompt = "Collect this"): Promise<string> {
  const project = join(root, "project")
  await mkdir(project, { recursive: true })
  const path = join(project, `${name}.jsonl`)
  await writeFile(
    path,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-01T17:00:00.000Z",
        cwd: "/tmp/work/project",
        message: { content: prompt },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-01T17:01:00.000Z",
        message: { content: "Collected" },
      }),
    ].join("\n") + "\n",
  )
  return path
}

function liveClaudeRoot(path: string): SourceRoot {
  return { source: "claude", path, layout: "project", restored: false }
}

function startIngestServer(
  handler: (request: Request) => Response | Promise<Response>,
  statusHandler?: (request: Request) => Response | Promise<Response>,
): Bun.Server<undefined> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === "/api/collector-status") {
        if (statusHandler) return statusHandler(request)
        collectorStatuses.push(await request.json())
        return new Response(null, { status: 204 })
      }
      return handler(request)
    },
  })
  servers.push(server)
  return server
}

function serverBase(server: Bun.Server<undefined>): string {
  return server.url.toString()
}

describe("source discovery", () => {
  test("lets live transcripts win over restored copies and excludes probes and subagents", async () => {
    const directory = await temporaryDirectory()
    const live = join(directory, "live")
    const restored = join(directory, "restored")
    const codex = join(directory, "codex")
    await writeClaudeSession(live, "same", "live")
    await writeClaudeSession(restored, "same", "restored")
    await writeClaudeSession(restored, "restored-only", "restored")
    await mkdir(join(live, "agent-project"), { recursive: true })
    await writeFile(join(live, "agent-project", "agent-child.jsonl"), "{}\n")
    await mkdir(join(live, "x-Library-Application-Support-CodexBar-ClaudeProbe"), { recursive: true })
    await writeFile(join(live, "x-Library-Application-Support-CodexBar-ClaudeProbe", "probe.jsonl"), "{}\n")
    await mkdir(join(codex, "2026", "07", "01"), { recursive: true })
    await writeFile(join(codex, "2026", "07", "01", "rollout-live.jsonl"), "{}\n")
    await mkdir(join(codex, "2026", "07", "01", "subagents"), { recursive: true })
    await writeFile(join(codex, "2026", "07", "01", "subagents", "rollout-child.jsonl"), "{}\n")

    const files = await Effect.runPromise(
      discoverSourceFiles([
        liveClaudeRoot(live),
        { source: "claude", path: restored, layout: "project", restored: true },
        { source: "codex", path: codex, layout: "codex", restored: false },
      ]),
    )
    const names = files.map((file) => file.path.slice(directory.length + 1))
    expect(names).toEqual([
      "codex/2026/07/01/rollout-live.jsonl",
      "live/project/same.jsonl",
      "restored/project/restored-only.jsonl",
    ])
  })

  test("parses only supported absolute source roots", () => {
    expect(parseSourceRoot("omp=/tmp/omp")).toEqual({ source: "omp", path: "/tmp/omp", layout: "project", restored: false })
    expect(parseSourceRoot("codex=/tmp/codex")).toEqual({ source: "codex", path: "/tmp/codex", layout: "codex", restored: false })
    expect(() => parseSourceRoot("cursor=/tmp/logs")).toThrow("unsupported source")
    expect(() => parseSourceRoot("pi=relative/logs")).toThrow("absolute")
    expect(() => parseSourceRoot("missing-separator")).toThrow()
  })
})

describe("collector state and locking", () => {
  test("atomically saves an exact mode-0600 state without leftover temporary files", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "nested", "collector.json")
    const state: CollectorState = {
      protocolVersion: 2,
      target: { server: "https://hub.example/", deviceId: "device-1", deviceName: "Laptop" },
      files: { "/tmp/fixture.jsonl": { size: 20, mtimeMs: 1234 } },
    }
    await Effect.runPromise(saveCollectorState(statePath, state))

    expect(await Effect.runPromise(loadCollectorState(statePath))).toEqual(state)
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(directory, "nested"))).toEqual(["collector.json"])
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(state)
  })

  test("rejects unknown or corrupt checkpoints instead of silently resetting them", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector.json")
    await writeFile(
      statePath,
      JSON.stringify({
        protocolVersion: 3,
        target: { server: "https://hub.example/", deviceId: "device-1", deviceName: "Laptop" },
        files: {},
      }),
    )
    await expect(Effect.runPromise(loadCollectorState(statePath))).rejects.toBeInstanceOf(Error)
    await writeFile(statePath, "{broken")
    await expect(Effect.runPromise(loadCollectorState(statePath))).rejects.toBeInstanceOf(Error)
  })

  test("rejects an overlapping live lock and recovers a dead-pid lock", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector.json")
    const lockPath = `${statePath}.lock`
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    let markAcquired!: () => void
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve
    })
    const holder = Effect.runPromise(
      withCollectorLock(
        statePath,
        Effect.promise(async () => {
          markAcquired()
          await gate
        }),
      ),
    )
    await acquired
    expect(await Bun.file(lockPath).exists()).toBe(true)
    const overlap = await Effect.runPromise(Effect.either(withCollectorLock(statePath, Effect.succeed("second"))))
    expect(overlap._tag).toBe("Left")
    if (overlap._tag === "Left") expect(overlap.left).toBeInstanceOf(CollectorBusyError)
    const server = startIngestServer(() => Response.json({ revision: 1 }))
    const ownedElsewhere = await Effect.runPromise(
      Effect.either(
        runCollection({
          server: serverBase(server),
          deviceId: "device-1",
          deviceName: "Laptop",
          statePath,
          roots: [liveClaudeRoot(join(directory, "source"))],
        }),
      ),
    )
    expect(ownedElsewhere._tag).toBe("Left")
    if (ownedElsewhere._tag === "Left") expect(ownedElsewhere.left).toBeInstanceOf(CollectorBusyError)
    expect(collectorStatuses).toEqual([])
    releaseGate()
    await holder
    expect(await Bun.file(lockPath).exists()).toBe(false)

    await writeFile(lockPath, "99999999", { mode: 0o600 })
    expect(await Effect.runPromise(withCollectorLock(statePath, Effect.succeed("recovered")))).toBe("recovered")
    expect(await Bun.file(lockPath).exists()).toBe(false)
  })
})

describe("collection synchronization", () => {
  test("checkpoints accepted batches, retries retryable HTTP, and batches at fifty", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    for (let index = 0; index < 51; index++) await writeClaudeSession(root, `session-${String(index).padStart(2, "0")}`)

    const requestSizes: number[] = []
    let requests = 0
    const server = startIngestServer(async (request) => {
      requests++
      const input: unknown = await request.json()
      const decoded = decodeExact(IngestRequestV2Schema, input)
      requestSizes.push(decoded.sessions.length)
      if (requests === 1) return Response.json({ error: "settling" }, { status: 503 })
      return Response.json({ accepted: decoded.sessions.length, unchanged: 0, revision: requests })
    })
    const sleeps: number[] = []
    const result = await Effect.runPromise(
      runCollection({
        server: serverBase(server),
        deviceId: "device-1",
        deviceName: "Laptop",
        statePath,
        roots: [liveClaudeRoot(root)],
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds)
        },
      }),
    )

    expect(result).toMatchObject({ discovered: 51, changed: 51, uploaded: 51, ignored: 0, unchanged: 0, revision: 3, errors: [] })
    expect(requestSizes).toEqual([50, 50, 1])
    expect(sleeps).toEqual([2000])
    expect(Object.keys((await Effect.runPromise(loadCollectorState(statePath)))!.files)).toHaveLength(51)
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses[0])).toMatchObject({
      outcome: {
        status: "processed",
        metrics: { discovered: 51, changed: 51, uploaded: 51, ignored: 0, unchanged: 0 },
        error: null,
      },
    })
  })

  test("replays every file when server or device identity changes and skips exact fingerprints", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    await writeClaudeSession(root, "identity")
    const seen: Array<{ id: string; name: string }> = []
    const receive = async (request: Request): Promise<Response> => {
      const decoded = decodeExact(IngestRequestV2Schema, await request.json())
      seen.push(decoded.device)
      return Response.json({ accepted: decoded.sessions.length, unchanged: 0, revision: seen.length })
    }
    const firstServer = startIngestServer(receive)
    const options = {
      server: serverBase(firstServer),
      deviceId: "device-a",
      deviceName: "Laptop A",
      statePath,
      roots: [liveClaudeRoot(root)],
    }

    expect((await Effect.runPromise(runCollection(options))).uploaded).toBe(1)
    expect(await Effect.runPromise(runCollection(options))).toMatchObject({ changed: 0, uploaded: 0, unchanged: 1 })
    expect(seen).toHaveLength(1)

    expect((await Effect.runPromise(runCollection({ ...options, deviceName: "Renamed Laptop" }))).uploaded).toBe(1)
    expect((await Effect.runPromise(runCollection({ ...options, deviceId: "device-b", deviceName: "Renamed Laptop" }))).uploaded).toBe(1)
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses[1])).toMatchObject({
      outcome: {
        status: "processed",
        metrics: { discovered: 1, changed: 0, uploaded: 0, ignored: 0, unchanged: 1 },
      },
    })
    const secondServer = startIngestServer(receive)
    expect(
      (
        await Effect.runPromise(
          runCollection({ ...options, server: serverBase(secondServer), deviceId: "device-b", deviceName: "Renamed Laptop" }),
        )
      ).uploaded,
    ).toBe(1)
    expect(seen).toEqual([
      { id: "device-a", name: "Laptop A" },
      { id: "device-a", name: "Renamed Laptop" },
      { id: "device-b", name: "Renamed Laptop" },
      { id: "device-b", name: "Renamed Laptop" },
    ])
  })

  test("treats a valid version-one checkpoint as stale and persists version two after replay", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    const filePath = await writeClaudeSession(root, "stale-state")
    const fingerprint = await stat(filePath)
    const server = startIngestServer(async (request) => {
      const decoded = decodeExact(IngestRequestV2Schema, await request.json())
      return Response.json({ accepted: decoded.sessions.length, unchanged: 0, revision: 1 })
    })
    const target = {
      server: serverBase(server),
      deviceId: "device-1",
      deviceName: "Laptop",
    }
    await writeFile(
      statePath,
      JSON.stringify({
        protocolVersion: 1,
        target,
        files: { [filePath]: { size: fingerprint.size, mtimeMs: fingerprint.mtimeMs } },
      }),
    )

    expect(await Effect.runPromise(loadCollectorState(statePath))).toBeNull()
    expect(
      await Effect.runPromise(
        runCollection({
          ...target,
          statePath,
          roots: [liveClaudeRoot(root)],
        }),
      ),
    ).toMatchObject({ changed: 1, uploaded: 1, unchanged: 0 })
    expect(JSON.parse(await readFile(statePath, "utf8")).protocolVersion).toBe(2)
  })

  test("checkpoints accepted batches while leaving a terminally failed batch for the next run", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    const filePaths: string[] = []
    for (let index = 0; index < 51; index++) {
      filePaths.push(await writeClaudeSession(root, `retry-${String(index).padStart(2, "0")}`))
    }
    const failedPath = filePaths.at(-1)!
    let rejectFinalBatch = true
    let requests = 0
    const server = startIngestServer(async (request) => {
      requests++
      const decoded = decodeExact(IngestRequestV2Schema, await request.json())
      if (rejectFinalBatch && decoded.sessions.length === 1) {
        return Response.json({ error: "bad request" }, { status: 400 })
      }
      return Response.json({ accepted: decoded.sessions.length, unchanged: 0, revision: requests })
    })
    const sleeps: number[] = []
    const options = {
      server: serverBase(server),
      deviceId: "device-1",
      deviceName: "Laptop",
      statePath,
      roots: [liveClaudeRoot(root)],
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds)
      },
    }

    const failed = await Effect.runPromise(Effect.either(runCollection(options)))
    expect(failed._tag).toBe("Left")
    if (failed._tag !== "Left") throw new Error("collection unexpectedly succeeded")
    expect(failed.left).toBeInstanceOf(CollectorError)
    expect((failed.left as CollectorError).result).toMatchObject({
      changed: 51,
      uploaded: 50,
      errors: ["http_400"],
    })
    const partialState = (await Effect.runPromise(loadCollectorState(statePath)))!
    expect(Object.keys(partialState.files)).toHaveLength(50)
    expect(partialState.files[failedPath]).toBeUndefined()
    expect(requests).toBe(2)
    expect(sleeps).toEqual([])
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses.at(-1))).toMatchObject({
      outcome: {
        status: "failed",
        metrics: { discovered: 51, changed: 51, uploaded: 50, ignored: 0, unchanged: 0 },
        error: "upload_error",
      },
    })

    rejectFinalBatch = false
    expect(await Effect.runPromise(runCollection(options))).toMatchObject({ changed: 1, uploaded: 1, unchanged: 50, errors: [] })
    expect((await Effect.runPromise(loadCollectorState(statePath)))!.files[failedPath]).toBeDefined()
    expect(requests).toBe(3)
  })

  test("checkpoints a stable ignored file without uploading it", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    const project = join(root, "project")
    await mkdir(project, { recursive: true })
    const filePath = join(project, "ignored.jsonl")

    await writeFile(filePath, '{"type":"user","timestamp":"2026-07-01T17:00:00.000Z"}\nmalformed\n')
    let requests = 0
    const server = startIngestServer(() => {
      requests++
      return Response.json({ revision: 1 })
    })
    const options = {
      server: serverBase(server),
      deviceId: "device-1",
      deviceName: "Laptop",
      statePath,
      roots: [liveClaudeRoot(root)],
    }

    expect(await Effect.runPromise(runCollection(options))).toMatchObject({ changed: 1, uploaded: 0, ignored: 1, unchanged: 0 })
    expect((await Effect.runPromise(loadCollectorState(statePath)))!.files[filePath]).toBeDefined()
    expect(await Effect.runPromise(runCollection(options))).toMatchObject({ changed: 0, uploaded: 0, ignored: 0, unchanged: 1 })
    expect(requests).toBe(0)
  })
  test("reports parse and collector failures with privacy-safe codes and nullable metrics", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    const unreadable = await writeClaudeSession(root, "unreadable")
    await chmod(unreadable, 0o000)
    const server = startIngestServer(() => Response.json({ revision: 1 }))
    const options = {
      server: serverBase(server),
      deviceId: "device-1",
      deviceName: "Laptop",
      statePath,
      roots: [liveClaudeRoot(root)],
    }
    const parseFailure = await Effect.runPromise(Effect.either(runCollection(options)))
    await chmod(unreadable, 0o600)
    expect(parseFailure._tag).toBe("Left")
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses.at(-1))).toMatchObject({
      outcome: {
        status: "failed",
        metrics: { discovered: 1, changed: 1, uploaded: 0, ignored: 0, unchanged: 0 },
        error: "parse_error",
      },
    })

    const uploadServer = startIngestServer(() => Response.json({ error: "bad request" }, { status: 400 }))
    const uploadFailure = await Effect.runPromise(
      Effect.either(
        runCollection({
          ...options,
          server: serverBase(uploadServer),
          statePath: join(directory, "upload-state.json"),
        }),
      ),
    )
    expect(uploadFailure._tag).toBe("Left")
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses.at(-1))).toMatchObject({
      outcome: {
        status: "failed",
        metrics: { discovered: 1, changed: 1, uploaded: 0, ignored: 0, unchanged: 0 },
        error: "upload_error",
      },
    })

    await writeFile(statePath, "{broken")
    const collectorFailure = await Effect.runPromise(Effect.either(runCollection(options)))
    expect(collectorFailure._tag).toBe("Left")
    expect(decodeExact(CollectorStatusV1Schema, collectorStatuses.at(-1))).toMatchObject({
      outcome: { status: "failed", metrics: null, error: "collector_error" },
    })
  })

  test("surfaces status failure after success but preserves an existing collection failure", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    const statusFailure = () => Response.json({ error: "unavailable" }, { status: 503 })
    const emptyServer = startIngestServer(() => Response.json({ revision: 1 }), statusFailure)
    const successfulCollection = await Effect.runPromise(
      Effect.either(
        runCollection({
          server: serverBase(emptyServer),
          deviceId: "device-1",
          deviceName: "Laptop",
          statePath,
          roots: [liveClaudeRoot(root)],
        }),
      ),
    )
    expect(successfulCollection._tag).toBe("Left")
    if (successfulCollection._tag === "Left") {
      expect(successfulCollection.left).not.toBeInstanceOf(CollectorError)
    }

    await writeClaudeSession(root, "upload-fails")
    const failingServer = startIngestServer(
      () => Response.json({ error: "bad request" }, { status: 400 }),
      statusFailure,
    )
    const collectionFailure = await Effect.runPromise(
      Effect.either(
        runCollection({
          server: serverBase(failingServer),
          deviceId: "device-1",
          deviceName: "Laptop",
          statePath: join(directory, "failing-state.json"),
          roots: [liveClaudeRoot(root)],
        }),
      ),
    )
    expect(collectionFailure._tag).toBe("Left")
    if (collectionFailure._tag === "Left") {
      expect(collectionFailure.left).toBeInstanceOf(CollectorError)
    }
  })
})
