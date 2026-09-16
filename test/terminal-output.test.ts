import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseSessionFile } from "../collector/session"
import { fixtureResponse } from "../plugins/herdr-trails/dev/fixture"
import { renderDashboard, type Screen, type ViewState } from "../plugins/herdr-trails/src/render"
import { fetchSnapshot } from "../plugins/herdr-trails/src/trails"
import { terminalText } from "../shared/terminal"

const controls = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/
const attack = "\x1b[2J\x1b[31m\x1b]52;c;Y2xpcGJvYXJk\x07\x1b]8;;https://example.invalid\x1b\\\x1b]8;;\x1b\\\x1bPprivate payload\x1b\\\x9b2J\x9d52;c;hidden\x9c\x90hidden\x9c\x08\x00\x7f\u202e\u2066\u2069"
const resolution = { url: "http://127.0.0.1:7414/", source: "environment" } as const
const state = (screen: Screen, detail = false): ViewState => ({ screen, detail, selected: { days: 0, week: 0, threads: 0, status: 0 }, help: false, loading: false, error: null })
const fixture = () => fetchSnapshot(resolution.url, { fetch: async input => fixtureResponse(new Request(input)), now: () => Date.parse("2026-08-17T18:30:00Z") })

function expectPlain(text: string) {
  expect(text.replaceAll("\n", "")).not.toMatch(controls)
}

describe("terminal text boundary", () => {
  test("keeps the standalone BB sanitizer identical to the shared implementation", () => {
    expect(readFileSync(join(import.meta.dir, "../plugins/bb-plugin-trails/terminal.ts"), "utf8"))
      .toBe(readFileSync(join(import.meta.dir, "../shared/terminal.ts"), "utf8"))
  })

  test("strips control sequences and payloads, preserving visible text and Unicode", () => {
    expect(terminalText(`hello${attack} café 日本語 👋 שלום`)).toBe("hello café 日本語 👋 שלום")
    expect(terminalText("\x1b]8;;https://example.invalid\x07label\x1b]8;;\x07")).toBe("label")
    expect(terminalText("one\r\ntwo\tthree\u2028four\u2029five")).toBe("one  two three four five")
    for (const code of [...Array(160).keys()].filter(code => code < 32 || code >= 127)) {
      expectPlain(terminalText(`a${String.fromCharCode(code)}z`))
    }
    expect(terminalText("a\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069z")).toBe("az")
  })

  test("handles ESC intermediates, every string control, and truncated sequences", () => {
    for (const introducer of ["\x1b]", "\x9d", "\x1bP", "\x90", "\x1bX", "\x98", "\x1b^", "\x9e", "\x1b_", "\x9f"]) {
      for (const terminator of ["\x1b\\", "\x9c"]) {
        expect(terminalText(`a${introducer}hidden${terminator}z`)).toBe("az")
      }
      expect(terminalText(`a${introducer}unterminated`)).toBe("a")
    }
    for (const sequence of ["\x1b[", "\x9b31;", "\x1b", "\x1b("]) expect(terminalText(`a${sequence}`)).toBe("a")
    expect(terminalText("a\x1b(B\x1b7\x1b8\x1bc\x1b\x1b[2Jz")).toBe("az")
    expect(terminalText(terminalText(attack))).toBe("")
  })

  test("sanitizes all dashboard views before wrapping, padding, truncation and ANSI styling", async () => {
    const clean = await fixture()
    const dirty = {
      ...clean,
      bootstrap: {
        ...clean.bootstrap,
        sessions: clean.bootstrap.sessions.map(session => ({ ...session, machine: { ...session.machine, name: attack + session.machine.name }, firstPrompt: attack + session.firstPrompt })),
        summaries: {
          sessions: Object.fromEntries(Object.entries(clean.bootstrap.summaries.sessions).map(([key, value]) => [key, attack + value])),
          days: Object.fromEntries(Object.entries(clean.bootstrap.summaries.days).map(([key, value]) => [key, attack + value])),
        },
        preferences: { ...clean.bootstrap.preferences, names: Object.fromEntries(Object.entries(clean.bootstrap.preferences.names).map(([key, value]) => [key, attack + value])) },
      },
      machines: clean.machines && { ...clean.machines, machines: clean.machines.machines.map(machine => ({ ...machine, name: attack + machine.name, lastError: attack + "synthetic failure" })) },
      warnings: [attack + "synthetic warning"],
    }
    const expected = { ...clean, machines: clean.machines && { ...clean.machines, machines: clean.machines.machines.map(machine => ({ ...machine, lastError: "synthetic failure" })) }, warnings: ["synthetic warning"] }
    const original = JSON.stringify(dirty)
    for (const screen of ["days", "week", "threads", "status"] as const) for (const detail of [false, true]) for (const width of [42, 80, 100]) {
      const options = { resolution, state: state(screen, detail), width, height: 40, now: clean.fetchedAt }
      const plain = renderDashboard({ ...options, snapshot: dirty, colors: false })
      expect(plain).toBe(renderDashboard({ ...options, snapshot: expected, colors: false }))
      expectPlain(plain)
      expect(plain.split("\n").every(line => line.length <= width)).toBe(true)
      const styled = renderDashboard({ ...options, snapshot: dirty, colors: true })
      expect(styled).toContain("\x1b[")
      expect(styled.replace(/\x1b\[[0-9;]*m/g, "")).toBe(plain)
    }
    expect(JSON.stringify(dirty)).toBe(original)
    const offline = renderDashboard({ snapshot: null, resolution, state: { ...state("days"), error: attack + "synthetic failure" }, width: 80, height: 20, colors: false })
    expect(offline).toContain("synthetic failure")
    expectPlain(offline)
  })

  for (const source of ["claude", "codex", "omp", "pi"] as const) test(`renders source-derived ${source} prompts without changing collected data`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "trails-terminal-"))
    try {
      const path = join(directory, "session.jsonl")
      const prompt = "Fix " + attack + "the bug"
      const message = source === "codex" ? { type: "event_msg", payload: { type: "user_message", message: prompt } }
        : { type: source === "claude" ? "user" : "message", message: { role: "user", content: prompt } }
      writeFileSync(path, [
        { ...message, timestamp: "2026-08-17T18:00:00Z", cwd: "/synthetic/project" },
        { type: "tick", timestamp: "2026-08-17T18:01:00Z" },
      ].map(value => JSON.stringify(value)).join("\n"))
      const parsed = await Effect.runPromise(parseSessionFile(path, source))
      expect(parsed?.firstPrompt).toContain("\x1b")
      const snapshot = await fixture()
      const original = snapshot.bootstrap.sessions[0]
      const output = renderDashboard({ snapshot: { ...snapshot, bootstrap: { ...snapshot.bootstrap, sessions: [{ ...original, cwd: "/synthetic/" + attack + "project", firstPrompt: parsed!.firstPrompt }], summaries: { sessions: {}, days: {} } } }, resolution, state: state("threads", true), width: 100, height: 30, colors: false })
      expect(output).toContain("Fix the bug")
      expect(output).toContain("/synthetic/project")
      expectPlain(output)
      expect(parsed?.firstPrompt).toContain("\x1b")
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test("plain --snapshot and startup errors contain no terminal controls", async () => {
    const snapshot = await fixture()
    const bootstrap = { ...snapshot.bootstrap, preferences: { ...snapshot.bootstrap.preferences, names: Object.fromEntries(Object.entries(snapshot.bootstrap.preferences.names).map(([key, value]) => [key, attack + value])) } }
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/bootstrap" ? Response.json(bootstrap) : fixtureResponse(request) })
    const run = async (env: Record<string, string>) => {
      const child = Bun.spawn([process.execPath, "plugins/herdr-trails/src/main.ts", "--snapshot"], { cwd: join(import.meta.dir, ".."), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { stdout, stderr, code }
    }
    try {
      const result = await run({ TRAILS_HERDR_SERVER_URL: server.url.href, COLUMNS: "100", LINES: "24" })
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("Trails, Sign-on")
      expect(result.stdout.split("\n")).toHaveLength(25)
      expectPlain(result.stdout)
      const failure = await run({ TRAILS_HERDR_SERVER_URL: "ftp://example.invalid/" + attack.replaceAll("\x00", "") })
      expect(failure.code).toBe(1)
      expectPlain(failure.stderr)
    } finally { server.stop(true) }
  })

  test("Trails CLI diagnostics sanitize attacker-controlled arguments", async () => {
    const child = Bun.spawn([process.execPath, "cli/main.ts", attack.replaceAll("\x00", "") + "unknown"], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).toBe(1)
    expect(stderr).toBe("unknown command: unknown\n")
  })
})
