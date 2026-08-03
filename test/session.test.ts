import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  MAX_AGENT_LEN,
  MAX_DIGEST,
  MAX_USER_LEN,
  MAX_USER_MSGS,
  parseSessionFile,
  sourceSessionId,
} from "../collector/session"
import type { Source } from "../shared/domain"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function fixture(name: string, lines: ReadonlyArray<string | object>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "trails-session-test-"))
  temporaryDirectories.push(directory)
  const path = join(directory, name)
  await writeFile(path, `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`)
  return path
}

async function parse(path: string, source: Source) {
  return Effect.runPromise(parseSessionFile(path, source))
}

function totals(activity: ReadonlyArray<readonly [string, number, number, number]>) {
  return activity.reduce(
    (sum, tuple) => ({ events: sum.events + tuple[2], users: sum.users + tuple[3] }),
    { events: 0, users: 0 },
  )
}

describe("session source ids", () => {
  test("derives stable ids without exposing source paths", () => {
    expect(sourceSessionId("/private/root/claude-id.jsonl", "claude")).toBe("claude-id")
    expect(sourceSessionId("/private/root/rollout-2026-07-01T10-20-30-codex-id.jsonl", "codex")).toBe("codex-id")
    expect(sourceSessionId("/private/root/2026-07-01T10-20-30-123Z_omp-id.jsonl", "omp")).toBe("omp-id")
    expect(sourceSessionId("/private/root/2026-07-01T10-20-30-123Z_pi-id.jsonl", "pi")).toBe("pi-id")
  })
})

describe("session JSONL parsing", () => {
  test("parses Claude while skipping malformed lines and canonicalizing timestamps", async () => {
    const path = await fixture("claude-id.jsonl", [
      "{malformed",
      {
        type: "user",
        timestamp: "2026-07-01T10:00:05-07:00",
        cwd: "/tmp/work/claude",
        gitBranch: "main",
        message: { content: [{ type: "text", text: "  <note>private tag</note> Build   the thing  " }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-01T17:00:40.000Z",
        message: { content: [{ type: "text", text: "Done" }] },
      },
    ])

    const result = await parse(path, "claude")
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      sourceSessionId: "claude-id",
      source: "claude",
      cwd: "/tmp/work/claude",
      branch: "main",
      start: "2026-07-01T17:00:05.000Z",
      end: "2026-07-01T17:00:40.000Z",
      events: 2,
      userEvents: 1,
      firstPrompt: "private tag Build the thing",
      activity: [["2026-07-01", 600, 2, 1]],
    })
    expect(totals(result!.activity)).toEqual({ events: result!.events, users: result!.userEvents })
  })

  test("parses Codex payload messages and excludes subagent transcripts", async () => {
    const path = await fixture("rollout-2026-07-01T10-20-30-codex-id.jsonl", [
      {
        type: "event_msg",
        timestamp: "2026-07-01T17:00:00.000Z",
        cwd: "/tmp/work/codex",
        gitBranch: "feature",
        payload: { type: "user_message", message: "Fix the parser" },
      },
      {
        type: "event_msg",
        timestamp: "2026-07-01T17:02:00.000Z",
        payload: { type: "agent_message", message: "Parser fixed" },
      },
    ])
    const result = await parse(path, "codex")
    expect(result).toMatchObject({
      sourceSessionId: "codex-id",
      source: "codex",
      cwd: "/tmp/work/codex",
      branch: "feature",
      events: 2,
      userEvents: 1,
      firstPrompt: "Fix the parser",
    })
    expect(totals(result!.activity)).toEqual({ events: 2, users: 1 })

    const subagent = await fixture("rollout-2026-07-01T10-20-30-subagent.jsonl", [
      { type: "session_meta", thread_source: "subagent", timestamp: "2026-07-01T17:00:00.000Z" },
      { type: "event_msg", timestamp: "2026-07-01T17:01:00.000Z", payload: { type: "user_message", message: "hidden" } },
    ])
    expect(await parse(subagent, "codex")).toBeNull()
  })

  test("applies the strict omp fork cutoff and keeps events at the child timestamp", async () => {
    const path = await fixture("2026-07-01T10-00-00-000Z_child-omp.jsonl", [
      {
        type: "session",
        id: "child-omp",
        parentSession: "/tmp/parent.jsonl",
        timestamp: "2026-07-01T17:00:00.000Z",
        cwd: "/tmp/work/omp",
      },
      {
        type: "message",
        timestamp: "2026-07-01T16:59:59.999Z",
        message: { role: "user", content: [{ type: "text", text: "parent history" }] },
      },
      {
        type: "message",
        timestamp: "2026-07-01T17:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "child prompt" }] },
      },
      {
        type: "message",
        timestamp: "2026-07-01T17:01:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "child answer" }] },
      },
    ])
    const result = await parse(path, "omp")
    expect(result).toMatchObject({
      sourceSessionId: "child-omp",
      source: "omp",
      start: "2026-07-01T17:00:00.000Z",
      end: "2026-07-01T17:01:00.000Z",
      events: 3,
      userEvents: 1,
      firstPrompt: "child prompt",
    })
    expect(result!.digest).not.toContain("parent history")
    expect(totals(result!.activity)).toEqual({ events: 3, users: 1 })
  })

  test("parses pi session-v3 messages and rejects sessions with fewer than two events", async () => {
    const path = await fixture("2026-07-01T10-00-00-000Z_pi-id.jsonl", [
      { type: "session", id: "pi-id", timestamp: "2026-07-01T17:00:00.000Z", cwd: "/tmp/work/pi" },
      {
        type: "message",
        timestamp: "2026-07-01T17:00:10.000Z",
        message: { role: "user", content: [{ type: "text", text: "Pi prompt" }] },
      },
      {
        type: "message",
        timestamp: "2026-07-01T17:00:20.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Pi answer" }] },
      },
    ])
    const result = await parse(path, "pi")
    expect(result).toMatchObject({ sourceSessionId: "pi-id", source: "pi", events: 3, userEvents: 1, firstPrompt: "Pi prompt" })

    const forked = await fixture("2026-07-01T10-00-00-000Z_pi-child.jsonl", [
      {
        type: "session",
        id: "pi-child",
        parentSession: "/tmp/parent.jsonl",
        timestamp: "2026-07-01T17:00:00.000Z",
        cwd: "/tmp/work/pi",
      },
      {
        type: "message",
        timestamp: "2026-07-01T16:59:00.000Z",
        message: { role: "user", content: "Pi parent history" },
      },
      {
        type: "message",
        timestamp: "2026-07-01T17:00:00.000Z",
        message: { role: "user", content: "Pi child prompt" },
      },
      {
        type: "message",
        timestamp: "2026-07-01T17:01:00.000Z",
        message: { role: "assistant", content: "Pi child answer" },
      },
    ])
    const forkedResult = await parse(forked, "pi")
    expect(forkedResult).toMatchObject({ start: "2026-07-01T17:00:00.000Z", events: 3, firstPrompt: "Pi child prompt" })
    expect(forkedResult!.digest).not.toContain("Pi parent history")

    const tooShort = await fixture("too-short.jsonl", [
      { type: "message", timestamp: "2026-07-01T17:00:00.000Z", message: { role: "user", content: "Only one" } },
      "not json",
    ])
    expect(await parse(tooShort, "pi")).toBeNull()
  })

  test("caps the digest and retains only the first bounded user messages", async () => {
    const lines: object[] = []
    for (let index = 0; index < MAX_USER_MSGS + 5; index++) {
      lines.push({
        type: "user",
        timestamp: new Date(Date.UTC(2026, 6, 1, 17, index)).toISOString(),
        cwd: "/tmp/work/bounds",
        message: { content: `${String(index).padStart(2, "0")}:${"u".repeat(MAX_USER_LEN + 100)}` },
      })
    }
    for (let index = 0; index < 5; index++) {
      lines.push({
        type: "assistant",
        timestamp: new Date(Date.UTC(2026, 6, 1, 18, index)).toISOString(),
        message: { content: `agent-${index}:${"a".repeat(MAX_AGENT_LEN + 100)}` },
      })
    }
    const path = await fixture("bounded.jsonl", lines)
    const result = await parse(path, "claude")

    expect(result).not.toBeNull()
    if (result === null) throw new Error("expected parsed session")
    if (result.digest === null) throw new Error("expected digest")
    expect(result!.firstPrompt).toHaveLength(240)
    expect(result!.digest.length).toBeLessThanOrEqual(MAX_DIGEST)
    expect(result!.digest).toContain(`first ${MAX_USER_MSGS} of ${MAX_USER_MSGS + 5}`)
    expect(result!.digest).not.toContain("24:")
    expect(result!.digest).not.toContain(`${"u".repeat(MAX_USER_LEN)}u`)
    expect(totals(result!.activity)).toEqual({ events: result!.events, users: result!.userEvents })
  })

  test("retains only the last three bounded agent messages", async () => {
    const lines: object[] = [
      {
        type: "user",
        timestamp: "2026-07-01T17:00:00.000Z",
        cwd: "/tmp/work/rolling",
        message: { content: `${"p".repeat(MAX_USER_LEN)}USER_TAIL` },
      },
      {
        type: "user",
        timestamp: "2026-07-01T17:01:00.000Z",
        message: { content: "Continue" },
      },
    ]
    for (let index = 0; index < 5; index++) {
      lines.push({
        type: "assistant",
        timestamp: new Date(Date.UTC(2026, 6, 1, 17, index + 2)).toISOString(),
        message: { content: [{ type: "text", text: `agent-${index}:${"a".repeat(MAX_AGENT_LEN)}TAIL-${index}` }] },
      })
    }
    const path = await fixture("rolling.jsonl", lines)
    const result = await parse(path, "claude")

    expect(result).not.toBeNull()
    expect(result!.digest).not.toContain("USER_TAIL")
    expect(result!.digest).not.toContain("agent-0:")
    expect(result!.digest).not.toContain("agent-1:")
    expect(result!.digest).toContain("agent-2:")
    expect(result!.digest).toContain("agent-3:")
    expect(result!.digest).toContain("agent-4:")
    expect(result!.digest).not.toContain("TAIL-4")
  })

  test("surfaces an unreadable file instead of checkpointing an empty session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trails-session-missing-"))
    temporaryDirectories.push(directory)
    await expect(parse(join(directory, "missing.jsonl"), "claude")).rejects.toBeInstanceOf(Error)
  })
})
