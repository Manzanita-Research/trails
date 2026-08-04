import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  BootstrapV1Schema,
  EngagementCreateSchema,
  IngestRequestV1Schema,
  PocketCreateSchema,
  ProjectPatchSchema,
  SettingsPatchSchema,
  decodeExact,
  encodeExact,
} from "../shared/protocol"

const session = () => ({
  sourceSessionId: "session-1",
  source: "claude",
  cwd: "/work/project",
  branch: "main",
  start: "2026-07-01T17:00:00.000Z",
  end: "2026-07-01T17:01:00.000Z",
  events: 2,
  userEvents: 1,
  firstPrompt: "Ship it",
  activity: [["2026-07-01", 600, 2, 1]],
  digest: "A bounded digest",
})

const request = () => ({
  protocolVersion: 1,
  device: { id: "device-1", name: "Desk Mac" },
  sessions: [session()],
})

const bootstrap = () => ({
  protocolVersion: 1,
  revision: 3,
  generatedAt: "2026-07-01T17:02:00.000Z",
  indexedAt: "2026-07-01T17:01:00.000Z",
  timezone: "America/Los_Angeles",
  sessions: [
    {
      id: "42",
      machine: { id: "device-1", name: "Desk Mac" },
      source: "claude",
      cwd: "/work/project",
      branch: "main",
      start: "2026-07-01T17:00:00.000Z",
      end: "2026-07-01T17:01:00.000Z",
      events: 2,
      userEvents: 1,
      firstPrompt: "Ship it",
      activity: [["2026-07-01", 600, 2, 1]],
    },
  ],
  summaries: { sessions: { "42": "Summary" }, days: { "2026-07-01|/work/project": "Day" } },
  preferences: {
    boundary: 6,
    halo: 10,
    assignments: { "/work/project": "org:work" },
    customEngagements: [{ id: "custom:1", name: "Studio" }],
    names: { "/work/project": "Project" },
    pocket: [{ id: "pocket-1", text: "Follow up", at: 1_750_000_000_000 }],
  },
})

function changed<T>(value: T, mutate: (copy: T) => void): T {
  const copy = structuredClone(value)
  mutate(copy)
  return copy
}

function rejects(schema: Schema.Schema.AnyNoContext, value: unknown): void {
  expect(() => decodeExact(schema, value)).toThrow()
}

describe("ingest protocol v1", () => {
  test("decodes only the exact wire shape", () => {
    expect(JSON.stringify(decodeExact(IngestRequestV1Schema, request()))).toBe(JSON.stringify(request()))
    rejects(IngestRequestV1Schema, { ...request(), transcript: "private" })
    rejects(
      IngestRequestV1Schema,
      changed(request(), (copy) => Object.assign(copy.sessions[0], { sourcePath: "/private/log.jsonl" })),
    )
    rejects(
      IngestRequestV1Schema,
      changed(request(), (copy) => Object.assign(copy.sessions[0], { transcriptBody: "private" })),
    )
    rejects(IngestRequestV1Schema, changed(request(), (copy) => Object.assign(copy.device, { extra: true })))
    rejects(IngestRequestV1Schema, changed(request(), (copy) => Object.assign(copy.sessions[0], { extra: true })))
  })

  test("enforces protocol, device, source, timestamp, and batch bounds", () => {
    const invalid: unknown[] = [
      changed(request(), (copy) => (copy.protocolVersion = 2)),
      changed(request(), (copy) => (copy.device.id = "")),
      changed(request(), (copy) => (copy.device.id = " padded ")),
      changed(request(), (copy) => (copy.device.id = "i".repeat(129))),
      changed(request(), (copy) => (copy.device.name = " ")),
      changed(request(), (copy) => (copy.device.name = "n".repeat(129))),
      changed(request(), (copy) => (copy.sessions = [])),
      changed(request(), (copy) => (copy.sessions = Array.from({ length: 51 }, session))),
      changed(request(), (copy) => (copy.sessions[0].source = "cursor")),
      changed(request(), (copy) => (copy.sessions[0].start = "2026-07-01T17:00:00Z")),
      changed(request(), (copy) => (copy.sessions[0].start = "2026-07-01T10:00:00.000-07:00")),
      changed(request(), (copy) => (copy.sessions[0].start = "not-a-date")),
      changed(request(), (copy) => (copy.sessions[0].start = "2026-07-01T18:00:00.000Z")),
    ]
    for (const value of invalid) rejects(IngestRequestV1Schema, value)

    const fifty = changed(request(), (copy) => (copy.sessions = Array.from({ length: 50 }, (_, index) => ({ ...session(), sourceSessionId: `s-${index}` }))))
    expect(decodeExact(IngestRequestV1Schema, fifty).sessions).toHaveLength(50)
    const maximumDevice = changed(request(), (copy) => {
      copy.device.id = "i".repeat(128)
      copy.device.name = "n".repeat(128)
    })
    expect(decodeExact(IngestRequestV1Schema, maximumDevice).device).toEqual(maximumDevice.device)
  })

  test("enforces every session string and count bound", () => {
    const invalid: unknown[] = [
      changed(request(), (copy) => (copy.sessions[0].sourceSessionId = "")),
      changed(request(), (copy) => (copy.sessions[0].sourceSessionId = "s".repeat(257))),
      changed(request(), (copy) => (copy.sessions[0].cwd = "c".repeat(4097))),
      changed(request(), (copy) => (copy.sessions[0].branch = "b".repeat(4097))),
      changed(request(), (copy) => (copy.sessions[0].firstPrompt = "p".repeat(241))),
      changed(request(), (copy) => (copy.sessions[0].digest = "d".repeat(9001))),
      changed(request(), (copy) => (copy.sessions[0].events = 1)),
      changed(request(), (copy) => (copy.sessions[0].events = 2.5)),
      changed(request(), (copy) => (copy.sessions[0].userEvents = -1)),
      changed(request(), (copy) => (copy.sessions[0].userEvents = 3)),
    ]
    for (const value of invalid) rejects(IngestRequestV1Schema, value)

    const limits = changed(request(), (copy) => {
      copy.sessions[0].sourceSessionId = "s".repeat(256)
      copy.sessions[0].cwd = "c".repeat(4096)
      copy.sessions[0].branch = "b".repeat(4096)
      copy.sessions[0].firstPrompt = "p".repeat(240)
      copy.sessions[0].digest = "d".repeat(9000)
    })
    expect(decodeExact(IngestRequestV1Schema, limits).sessions[0]).toMatchObject(limits.sessions[0])
    const nullables = changed(request(), (copy) => {
      Object.assign(copy.sessions[0], { cwd: null, branch: null, firstPrompt: null, digest: null })
    })
    expect(decodeExact(IngestRequestV1Schema, nullables).sessions[0]).toMatchObject(nullables.sessions[0])
  })

  test("requires sorted unique activity with valid buckets and exact totals", () => {
    const invalidActivities = [
      [],
      [["2026-02-30", 1, 2, 1]],
      [["2026-07-01", -1, 2, 1]],
      [["2026-07-01", 1440, 2, 1]],
      [["2026-07-01", 1.5, 2, 1]],
      [["2026-07-01", 1, 0, 0]],
      [["2026-07-01", 1, 2, -1]],
      [["2026-07-01", 1, 1, 2]],
      [["2026-07-01", 1, 1, 1], ["2026-07-01", 1, 1, 0]],
      [["2026-07-02", 1, 1, 1], ["2026-07-01", 1, 1, 0]],
      [["2026-07-01", 1, 1, 1]],
    ]
    for (const activity of invalidActivities) {
      rejects(IngestRequestV1Schema, changed(request(), (copy) => (copy.sessions[0].activity = activity)))
    }

    const edge = changed(request(), (copy) => {
      copy.sessions[0].activity = [["2026-07-01", 0, 1, 1], ["2026-07-01", 1439, 1, 0]]
    })
    expect(JSON.stringify(decodeExact(IngestRequestV1Schema, edge).sessions[0].activity)).toBe(
      JSON.stringify(edge.sessions[0].activity),
    )
  })
})

describe("bootstrap and mutation schemas", () => {
  test("round-trips the exact bootstrap v1 shape", () => {
    const decoded = decodeExact(BootstrapV1Schema, bootstrap())
    expect(encodeExact(BootstrapV1Schema, decoded)).toEqual(bootstrap())
    rejects(BootstrapV1Schema, { ...bootstrap(), sourceSessionId: "private" })
    rejects(
      BootstrapV1Schema,
      changed(bootstrap(), (copy) => Object.assign(copy.sessions[0], { digest: "private" })),
    )
  })

  test("enforces bootstrap literals, dates, ids, preferences, and pocket bounds", () => {
    const invalid: unknown[] = [
      changed(bootstrap(), (copy) => (copy.protocolVersion = 2)),
      changed(bootstrap(), (copy) => (copy.revision = -1)),
      changed(bootstrap(), (copy) => (copy.generatedAt = "2026-07-01T17:02:00Z")),
      changed(bootstrap(), (copy) => (copy.timezone = "UTC")),
      changed(bootstrap(), (copy) => (copy.sessions[0].id = "")),
      changed(bootstrap(), (copy) => (copy.sessions[0].id = "i".repeat(65))),
      changed(bootstrap(), (copy) => (copy.sessions[0].machine.name = " padded ")),
      changed(bootstrap(), (copy) => (copy.sessions[0].cwd = "c".repeat(4097))),
      changed(bootstrap(), (copy) => (copy.sessions[0].firstPrompt = "p".repeat(241))),
      changed(bootstrap(), (copy) => (copy.preferences.boundary = 8)),
      changed(bootstrap(), (copy) => (copy.preferences.halo = 6)),
      changed(bootstrap(), (copy) => (copy.preferences.customEngagements[0].id = "i".repeat(129))),
      changed(bootstrap(), (copy) => (copy.preferences.customEngagements[0].name = "n".repeat(81))),
      changed(bootstrap(), (copy) => (copy.preferences.pocket[0].id = "i".repeat(129))),
      changed(bootstrap(), (copy) => (copy.preferences.pocket[0].text = "t".repeat(501))),
      changed(bootstrap(), (copy) => (copy.preferences.pocket[0].at = -1)),
    ]
    for (const value of invalid) rejects(BootstrapV1Schema, value)
  })

  test("enforces mutation field presence and documented limits", () => {
    expect(decodeExact(SettingsPatchSchema, {})).toEqual({})
    expect(decodeExact(SettingsPatchSchema, { boundary: 4, halo: 15 })).toEqual({ boundary: 4, halo: 15 })
    rejects(SettingsPatchSchema, { boundary: 3 })
    rejects(SettingsPatchSchema, { halo: 1 })
    rejects(SettingsPatchSchema, { boundary: 6, extra: true })

    expect(decodeExact(ProjectPatchSchema, { project: "/work", engagementId: null, displayName: "" })).toEqual({ project: "/work", engagementId: null, displayName: "" })
    expect(
      decodeExact(ProjectPatchSchema, {
        project: "p".repeat(4096),
        engagementId: "e".repeat(4096),
        displayName: "n".repeat(80),
      }),
    ).toBeDefined()
    rejects(ProjectPatchSchema, { project: "" })
    rejects(ProjectPatchSchema, { project: " padded " })
    rejects(ProjectPatchSchema, { project: "p".repeat(4097) })
    rejects(ProjectPatchSchema, { project: "/work", engagementId: " " })
    rejects(ProjectPatchSchema, { project: "/work", engagementId: "e".repeat(4097) })
    rejects(ProjectPatchSchema, { project: "/work", displayName: "n".repeat(81) })

    expect(decodeExact(EngagementCreateSchema, { name: "Studio" })).toEqual({ name: "Studio" })
    expect(decodeExact(EngagementCreateSchema, { name: "n".repeat(80) }).name).toHaveLength(80)
    rejects(EngagementCreateSchema, { name: " " })
    rejects(EngagementCreateSchema, { name: "n".repeat(81) })
    expect(decodeExact(PocketCreateSchema, { text: "Follow up" })).toEqual({ text: "Follow up" })
    expect(decodeExact(PocketCreateSchema, { text: "t".repeat(500) }).text).toHaveLength(500)
    rejects(PocketCreateSchema, { text: " padded " })
    rejects(PocketCreateSchema, { text: "t".repeat(501) })
  })
})
