import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
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
import { IngestRequestV1Schema, decodeExact } from "../shared/protocol"

const temporaryDirectories: string[] = []
const servers: Bun.Server<undefined>[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
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

function startIngestServer(handler: (request: Request) => Response | Promise<Response>): Bun.Server<undefined> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
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
      protocolVersion: 1,
      target: { server: "https://hub.example/", deviceId: "device-1", deviceName: "Laptop" },
      files: { "/tmp/fixture.jsonl": { size: 20, mtimeMs: 1234 } },
    }
    await Effect.runPromise(saveCollectorState(statePath, state))

    expect(await Effect.runPromise(loadCollectorState(statePath))).toEqual(state)
    expect((await stat(statePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(join(directory, "nested"))).toEqual(["collector.json"])
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(state)
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
      const decoded = decodeExact(IngestRequestV1Schema, input)
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
  })

  test("replays every file when server or device identity changes and skips exact fingerprints", async () => {
    const directory = await temporaryDirectory()
    const root = join(directory, "source")
    const statePath = join(directory, "collector-state.json")
    await writeClaudeSession(root, "identity")
    const seen: Array<{ id: string; name: string }> = []
    const receive = async (request: Request): Promise<Response> => {
      const decoded = decodeExact(IngestRequestV1Schema, await request.json())
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
      const decoded = decodeExact(IngestRequestV1Schema, await request.json())
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
})
