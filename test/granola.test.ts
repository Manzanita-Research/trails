import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_GRANOLA_CLI_PATH,
  configureCollector,
  configureGranola,
  disableGranola,
  loadCollectorConfig,
} from "../cli/config"
import { runCaptureCollection } from "../collector/captures"
import {
  GranolaAdapter,
  normalizeGranolaNote,
  type GranolaCommandResult,
  type GranolaCommandRunner,
} from "../collector/granola"
import { OneShotCollectionError, runOneShotCollection } from "../collector/once"
import { loadCollectorState, saveCollectorState } from "../collector/state"
import { decodeExact, GranolaCaptureV1Schema } from "../shared/protocol"

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "trails-granola-test-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const noteA = "123e4567-e89b-42d3-a456-426614174000"
const noteB = "123e4567-e89b-42d3-a456-426614174001"

function listNote(id: string, createdAt: string, updatedAt: string) {
  return {
    id,
    title: "Private list title",
    created_at: createdAt,
    updated_at: updatedAt,
    type: "meeting" as const,
    status: "complete",
    owner: { name: "Private Owner", email: "owner@example.com" },
    calendar_event: null,
  }
}

function detail(id: string, overrides: Record<string, unknown> = {}) {
  return {
    ...listNote(id, "2026-08-03T17:00:00Z", "2026-08-03T18:00:00Z"),
    title: "Synthetic meeting",
    calendar_event: {
      event_title: "Private event title",
      invitees: [{ email: "one@example.com" }, { email: "two@example.com" }],
      organiser: "private@example.com",
      calendar_event_id: "private-calendar-id",
      scheduled_start_time: "2026-08-03T17:00:00Z",
      scheduled_end_time: "2026-08-03T17:03:00Z",
    },
    notes_plain: "Private notes fallback",
    notes_markdown: "**Private markdown notes**",
    summary_text: "Synthetic plain summary",
    summary_markdown: "**Private markdown summary**",
    ...overrides,
  }
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    binaryPath: DEFAULT_GRANOLA_CLI_PATH,
    initialCreatedAfter: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

function commandResult(value: unknown): GranolaCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" }
}

function granolaCursor(
  collectedAt: string,
  initialCreatedAfter = "2026-08-01T00:00:00.000Z",
): string {
  return `granola-v1/${initialCreatedAfter}/${collectedAt}`
}

describe("Granola local companion CLI collection", () => {
  test("paginates local notes, never requests transcripts, and retains only bounded display fields", async () => {
    const calls: Array<{ binaryPath: string; args: ReadonlyArray<string> }> = []
    const run: GranolaCommandRunner = async (binaryPath, args) => {
      calls.push({ binaryPath, args: [...args] })
      if (args[0] === "notes" && args[1] === "list" && args.at(-1) === "0") {
        return commandResult({
          notes: [listNote(noteA, "2026-08-03T17:00:00Z", "2026-08-03T18:00:00Z")],
          has_more: true,
          next_offset: 100,
        })
      }
      if (args[0] === "notes" && args[1] === "list") {
        return commandResult({
          notes: [listNote(noteB, "2026-08-03T19:30:00Z", "2026-08-03T20:00:00Z")],
          has_more: false,
          next_offset: null,
        })
      }
      if (args.at(-1) === noteA) {
        return commandResult({ notes: [detail(noteA, { summary_text: "Plain text wins" })], not_found: [] })
      }
      if (args.at(-1) === noteB) {
        return commandResult({
          notes: [
            detail(noteB, {
              title: null,
              created_at: "2026-08-03T19:30:00Z",
              updated_at: "2026-08-03T20:00:00Z",
              calendar_event: null,
              summary_text: null,
              summary_markdown: null,
              notes_plain: "Local notes fallback",
            }),
          ],
          not_found: [],
        })
      }
      throw new Error("unexpected command")
    }
    const adapter = new GranolaAdapter(config(), {
      run,
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
    })
    const result = await adapter.collect(null)

    expect(calls).toEqual([
      {
        binaryPath: DEFAULT_GRANOLA_CLI_PATH,
        args: [
          "notes",
          "list",
          "--created-after",
          "2026-08-01T00:00:00.000Z",
          "--limit",
          "100",
          "--offset",
          "0",
        ],
      },
      {
        binaryPath: DEFAULT_GRANOLA_CLI_PATH,
        args: [
          "notes",
          "list",
          "--created-after",
          "2026-08-01T00:00:00.000Z",
          "--limit",
          "100",
          "--offset",
          "100",
        ],
      },
      { binaryPath: DEFAULT_GRANOLA_CLI_PATH, args: ["notes", "get", "--id", noteA] },
      { binaryPath: DEFAULT_GRANOLA_CLI_PATH, args: ["notes", "get", "--id", noteB] },
    ])
    expect(calls.every(({ args }) => !args.includes("transcript"))).toBe(true)
    expect(result.nextCursor).toBe(granolaCursor("2026-08-04T12:00:00.000Z"))
    expect(result.captures).toEqual([
      {
        source: "granola",
        sourceRecordId: noteA,
        project: null,
        projectHint: null,
        title: "Synthetic meeting",
        startedAt: "2026-08-03T17:00:00.000Z",
        endedAt: "2026-08-03T17:03:00.000Z",
        summaryInput: "Plain text wins",
        attentionMinutes: [
          Math.floor(Date.parse("2026-08-03T17:00:00.000Z") / 60_000),
          Math.floor(Date.parse("2026-08-03T17:01:00.000Z") / 60_000),
          Math.floor(Date.parse("2026-08-03T17:02:00.000Z") / 60_000),
        ],
        payload: { attendeeCount: 2 },
        images: [],
      },
      {
        source: "granola",
        sourceRecordId: noteB,
        project: null,
        projectHint: null,
        title: "Untitled meeting",
        startedAt: "2026-08-03T19:30:00.000Z",
        endedAt: null,
        summaryInput: "Local notes fallback",
        attentionMinutes: [Math.floor(Date.parse("2026-08-03T19:30:00.000Z") / 60_000)],
        payload: { attendeeCount: 0 },
        images: [],
      },
    ])
    const serialized = JSON.stringify(result)
    for (const privateValue of [
      "Private Owner",
      "owner@example.com",
      "one@example.com",
      "Private event title",
      "private-calendar-id",
      "Private notes fallback",
      "Private markdown summary",
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  test("clamps bounded text and treats oversized all-day events as creation-time points", () => {
    const capture = normalizeGranolaNote(
      detail(noteA, {
        title: "T".repeat(250),
        summary_text: "S".repeat(13_000),
        calendar_event: {
          event_title: null,
          invitees: [],
          organiser: null,
          calendar_event_id: null,
          scheduled_start_time: "2026-08-01",
          scheduled_end_time: "2026-08-15",
        },
      }),
    )
    expect(capture).not.toBeNull()
    expect(capture?.title).toHaveLength(200)
    expect(capture?.summaryInput).toHaveLength(12_000)
    expect(capture?.startedAt).toBe("2026-08-03T17:00:00.000Z")
    expect(capture?.endedAt).toBeNull()
    expect(capture?.attentionMinutes).toEqual([Math.floor(Date.parse("2026-08-03T17:00:00.000Z") / 60_000)])

    const boundaryCapture = normalizeGranolaNote(
      detail(noteB, {
        title: `${"T".repeat(199)}😀ignored`,
        summary_text: `${"S".repeat(11_999)} \nignored`,
      }),
    )
    expect(boundaryCapture).not.toBeNull()
    if (!boundaryCapture) throw new Error("expected a bounded capture")
    expect(boundaryCapture?.title).toBe("T".repeat(199))
    expect(boundaryCapture?.summaryInput).toBe("S".repeat(11_999))
    expect(decodeExact(GranolaCaptureV1Schema, boundaryCapture)).toEqual(boundaryCapture)
  })

  test("rescans the previous day so newly completed local summaries are collected", async () => {
    const calls: ReadonlyArray<string>[] = []
    const adapter = new GranolaAdapter(config(), {
      now: () => Date.parse("2026-08-04T12:05:00.000Z"),
      run: async (_binaryPath, args) => {
        calls.push([...args])
        return commandResult({ notes: [], has_more: false, next_offset: null })
      },
    })
    expect(await adapter.collect(granolaCursor("2026-08-04T12:00:00.000Z"))).toEqual({
      captures: [],
      nextCursor: granolaCursor("2026-08-04T12:05:00.000Z"),
    })
    expect(calls[0]).toContain("2026-08-03T12:00:00.000Z")
  })

  test("resets the source cursor when the configured initial boundary changes", async () => {
    const calls: ReadonlyArray<string>[] = []
    const adapter = new GranolaAdapter(config({ initialCreatedAfter: "2026-07-01T00:00:00.000Z" }), {
      now: () => Date.parse("2026-08-05T12:00:00.000Z"),
      run: async (_binaryPath, args) => {
        calls.push([...args])
        return commandResult({ notes: [], has_more: false, next_offset: null })
      },
    })
    const result = await adapter.collect(granolaCursor("2026-08-04T12:00:00.000Z"))
    expect(calls[0]).toContain("2026-07-01T00:00:00.000Z")
    expect(result.nextCursor).toBe(
      granolaCursor("2026-08-05T12:00:00.000Z", "2026-07-01T00:00:00.000Z"),
    )
  })

  test("skips notes without local summary or notes so the lookback can retry them", async () => {
    const run: GranolaCommandRunner = async (_binaryPath, args) =>
      args[1] === "list"
        ? commandResult({
            notes: [listNote(noteA, "2026-08-03T17:00:00Z", "2026-08-03T18:00:00Z")],
            has_more: false,
            next_offset: null,
          })
        : commandResult({
            notes: [
              detail(noteA, {
                summary_text: null,
                summary_markdown: null,
                notes_plain: null,
                notes_markdown: null,
              }),
            ],
            not_found: [],
          })
    const result = await new GranolaAdapter(config(), {
      run,
      now: () => Date.parse("2026-08-04T12:00:00.000Z"),
    }).collect(null)
    expect(result.captures).toEqual([])
    expect(result.nextCursor).toBe(granolaCursor("2026-08-04T12:00:00.000Z"))
  })

  test("fails closed on malformed pagination, response drift, and unstructured command errors", async () => {
    await expect(
      new GranolaAdapter(config(), {
        run: async () => commandResult({ notes: [], has_more: true, next_offset: null }),
      }).collect(null),
    ).rejects.toThrow("pagination is incomplete")

    await expect(
      new GranolaAdapter(config(), {
        run: async () => commandResult({ notes: [{ id: noteA }], has_more: false, next_offset: null }),
      }).collect(null),
    ).rejects.toThrow("list response shape changed")

    let pageCalls = 0
    await expect(
      new GranolaAdapter(config(), {
        run: async () => {
          pageCalls++
          return commandResult({ notes: [], has_more: true, next_offset: pageCalls * 100 })
        },
      }).collect(null),
    ).rejects.toThrow("pagination did not terminate")
    expect(pageCalls).toBe(100)

    await expect(
      new GranolaAdapter(config(), {
        run: async () => ({
          exitCode: 1,
          stdout: JSON.stringify({
            error: { code: "APP_NOT_RUNNING", message: "private provider detail" },
          }),
          stderr: "",
        }),
      }).collect(null),
    ).rejects.toThrow("Granola Desktop is not running or its Companion CLI is disabled")

    const privateError = "private meeting content must not escape"
    const failure = await new GranolaAdapter(config(), {
      run: async () => ({ exitCode: 1, stdout: "", stderr: privateError }),
    }).collect(null).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("command failed")
    expect((failure as Error).message).not.toContain(privateError)
  })

  test("retains the source cursor when the local CLI fails", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector.json")
    const target = { server: "http://127.0.0.1:7412/", deviceId: "device-1", deviceName: "Laptop" }
    await Effect.runPromise(
      saveCollectorState(statePath, {
        protocolVersion: 3,
        target,
        files: { "/tmp/session.jsonl": { size: 1, mtimeMs: 2 } },
        captureCursors: { midjourney: "mid", granola: granolaCursor("2026-08-03T16:30:00.000Z") },
      }),
    )
    const failed = await Effect.runPromise(
      Effect.either(
        runCaptureCollection({
          ...target,
          statePath,
          adapter: new GranolaAdapter(config(), {
            run: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
          }),
        }),
      ),
    )
    expect(failed._tag).toBe("Left")
    expect((await Effect.runPromise(loadCollectorState(statePath)))!.captureCursors).toEqual({
      midjourney: "mid",
      granola: granolaCursor("2026-08-03T16:30:00.000Z"),
    })
  })
})

describe("Granola collector configuration", () => {
  test("migrates secure v1 config, preserves local settings on target changes, and disables cleanly", async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, "collector.json")
    await writeFile(
      path,
      JSON.stringify({
        protocolVersion: 1,
        server: "http://127.0.0.1:7412/",
        deviceId: "device-1",
        deviceName: "Laptop",
      }),
      { mode: 0o600 },
    )
    expect(loadCollectorConfig(path)).toEqual({
      protocolVersion: 2,
      server: "http://127.0.0.1:7412/",
      deviceId: "device-1",
      deviceName: "Laptop",
      granola: null,
    })

    let configured = configureGranola({
      path,
      initialCreatedAfter: "2026-08-03T16:00:00.000Z",
    })
    expect(configured.granola).toEqual({
      binaryPath: DEFAULT_GRANOLA_CLI_PATH,
      initialCreatedAfter: "2026-08-03T16:00:00.000Z",
    })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(configured)).not.toMatch(/token|secret|credential/i)

    configured = configureCollector({ server: "http://127.0.0.1:7413/", name: "Renamed", path })
    expect(configured.granola?.binaryPath).toBe(DEFAULT_GRANOLA_CLI_PATH)
    expect(disableGranola(path).granola).toBeNull()
    expect(JSON.parse(await readFile(path, "utf8")).granola).toBeNull()
  })

  test("requires an existing target, canonical time, absolute binary path, and owner-only permissions", async () => {
    const directory = await temporaryDirectory()
    const missing = join(directory, "missing.json")
    expect(() =>
      configureGranola({
        path: missing,
        initialCreatedAfter: "2026-08-03T16:00:00.000Z",
      }),
    ).toThrow("collector target")

    const path = join(directory, "collector.json")
    configureCollector({ server: "http://127.0.0.1:7412/", path })
    expect(() =>
      configureGranola({
        path,
        initialCreatedAfter: "2026-08-03T16:00:00Z",
      }),
    ).toThrow("canonical")
    expect(() =>
      configureGranola({
        path,
        binaryPath: "relative/granola",
        initialCreatedAfter: "2026-08-03T16:00:00.000Z",
      }),
    ).toThrow("absolute")

    await chmod(path, 0o644)
    expect(() => loadCollectorConfig(path)).toThrow("invalid")
  })
})

describe("one-shot provider independence", () => {
  test("preserves the successful session checkpoint when local Granola collection fails", async () => {
    const directory = await temporaryDirectory()
    const statePath = join(directory, "collector-state.json")
    const failed = await runOneShotCollection({
      server: "http://127.0.0.1:7412/",
      deviceId: "device-1",
      deviceName: "Laptop",
      statePath,
      roots: [],
      fetch: Object.assign(async (input: Parameters<typeof fetch>[0]) => {
        expect(new URL(String(input)).pathname).toBe("/api/collector-status")
        return new Response(null, { status: 204 })
      }, { preconnect() {} }),
      granola: config(),
      granolaRun: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    }).catch((error: unknown) => error)
    expect(failed).toBeInstanceOf(OneShotCollectionError)
    if (!(failed instanceof OneShotCollectionError)) throw new Error("expected one-shot failure")
    expect(failed.result.sessions).toMatchObject({ uploaded: 0, errors: [] })
    expect(failed.result.granola).toBeNull()
    expect(failed.providerErrors[0]).toStartWith("granola:")
    expect(await Effect.runPromise(loadCollectorState(statePath))).toMatchObject({
      files: {},
      captureCursors: { midjourney: null, granola: null },
    })
  })
})
