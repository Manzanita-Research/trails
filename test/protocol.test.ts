import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  BootstrapV1Schema,
  CollectorStatusV1Schema,
  EngagementCreateSchema,
  IngestRequestV2Schema,
  MachinesV1Schema,
  SummarizationMetadataV1Schema,
  SummarizationStatusV1Schema,
  PocketCreateSchema,
  ProjectPatchSchema,
  SettingsPatchSchema,
  decodeExact,
  encodeExact,
} from "../shared/protocol"
import { localActivityOf, workdaysOfUtc } from "../shared/domain"

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
  activity: [[1, 2, 1]],
  digest: "A bounded digest",
})

const request = () => ({
  protocolVersion: 2,
  device: { id: "device-1", name: "Desk Mac" },
  sessions: [session()],
})

const bootstrap = () => ({
  protocolVersion: 1,
  revision: 3,
  generatedAt: "2026-07-01T17:02:00.000Z",
  indexedAt: "2026-07-01T17:01:00.000Z",
  hubUrl: "https://trails.example.ts.net/",
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
    onboardingVersion: 0,
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

describe("ingest protocol v2", () => {
  test("decodes only the exact wire shape", () => {
    expect(JSON.stringify(decodeExact(IngestRequestV2Schema, request()))).toBe(JSON.stringify(request()))
    rejects(IngestRequestV2Schema, { ...request(), transcript: "private" })
    rejects(
      IngestRequestV2Schema,
      changed(request(), (copy) => Object.assign(copy.sessions[0], { sourcePath: "/private/log.jsonl" })),
    )
    rejects(
      IngestRequestV2Schema,
      changed(request(), (copy) => Object.assign(copy.sessions[0], { transcriptBody: "private" })),
    )
    rejects(IngestRequestV2Schema, changed(request(), (copy) => Object.assign(copy.device, { extra: true })))
    rejects(IngestRequestV2Schema, changed(request(), (copy) => Object.assign(copy.sessions[0], { extra: true })))
  })

  test("enforces protocol, device, source, timestamp, and batch bounds", () => {
    const invalid: unknown[] = [
      changed(request(), (copy) => (copy.protocolVersion = 1)),
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
    for (const value of invalid) rejects(IngestRequestV2Schema, value)

    const fifty = changed(request(), (copy) => (copy.sessions = Array.from({ length: 50 }, (_, index) => ({ ...session(), sourceSessionId: `s-${index}` }))))
    expect(decodeExact(IngestRequestV2Schema, fifty).sessions).toHaveLength(50)
    const maximumDevice = changed(request(), (copy) => {
      copy.device.id = "i".repeat(128)
      copy.device.name = "n".repeat(128)
    })
    expect(decodeExact(IngestRequestV2Schema, maximumDevice).device).toEqual(maximumDevice.device)
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
    for (const value of invalid) rejects(IngestRequestV2Schema, value)

    const limits = changed(request(), (copy) => {
      copy.sessions[0].sourceSessionId = "s".repeat(256)
      copy.sessions[0].cwd = "c".repeat(4096)
      copy.sessions[0].branch = "b".repeat(4096)
      copy.sessions[0].firstPrompt = "p".repeat(240)
      copy.sessions[0].digest = "d".repeat(9000)
    })
    expect(decodeExact(IngestRequestV2Schema, limits).sessions[0]).toMatchObject(limits.sessions[0])
    const nullables = changed(request(), (copy) => {
      Object.assign(copy.sessions[0], { cwd: null, branch: null, firstPrompt: null, digest: null })
    })
    expect(decodeExact(IngestRequestV2Schema, nullables).sessions[0]).toMatchObject(nullables.sessions[0])
  })

  test("requires sorted unique activity with valid buckets and exact totals", () => {
    const invalidActivities = [
      [],
      [[-1, 2, 1]],
      [[1.5, 2, 1]],
      [[1, 0, 0]],
      [[1, 2, -1]],
      [[1, 1, 2]],
      [[1, 1, 1], [1, 1, 0]],
      [[2, 1, 1], [1, 1, 0]],
      [[1, 1, 1]],
    ]
    for (const activity of invalidActivities) {
      rejects(IngestRequestV2Schema, changed(request(), (copy) => (copy.sessions[0].activity = activity)))
    }

    const edge = changed(request(), (copy) => {
      copy.sessions[0].activity = [[0, 1, 1], [2, 1, 0]]
    })
    expect(JSON.stringify(decodeExact(IngestRequestV2Schema, edge).sessions[0].activity)).toBe(
      JSON.stringify(edge.sessions[0].activity),
    )
  })
})

describe("timezone localization", () => {
  test("derives configured workdays and preserves DST transition buckets", () => {
    const utcMinute = Math.floor(Date.parse("2026-08-04T08:00:00.000Z") / 60_000)
    expect([...workdaysOfUtc([[utcMinute, 1, 1]], 6, "America/Los_Angeles")]).toEqual([
      "2026-08-03",
    ])
    expect([...workdaysOfUtc([[utcMinute, 1, 1]], 6, "Europe/Rome")]).toEqual([
      "2026-08-04",
    ])

    const spring = localActivityOf(
      [
        [Math.floor(Date.parse("2026-03-08T09:59:00.000Z") / 60_000), 1, 1],
        [Math.floor(Date.parse("2026-03-08T10:00:00.000Z") / 60_000), 1, 0],
      ],
      "America/Los_Angeles",
    )
    expect(spring).toEqual([
      ["2026-03-08", 119, 1, 1],
      ["2026-03-08", 180, 1, 0],
    ])
  })

  test("merges and sorts the repeated fall-back hour before bootstrap decoding", () => {
    const localized = localActivityOf(
      [
        [Math.floor(Date.parse("2026-11-01T08:30:00.000Z") / 60_000), 1, 1],
        [Math.floor(Date.parse("2026-11-01T09:30:00.000Z") / 60_000), 2, 0],
        [Math.floor(Date.parse("2026-11-01T10:30:00.000Z") / 60_000), 1, 0],
      ],
      "America/Los_Angeles",
    )
    expect(localized).toEqual([
      ["2026-11-01", 90, 3, 1],
      ["2026-11-01", 150, 1, 0],
    ])
    const base = bootstrap()
    const wire = { ...base, sessions: [{ ...base.sessions[0], activity: localized }] }
    expect(decodeExact(BootstrapV1Schema, wire).sessions[0].activity).toEqual(localized)
  })
})

describe("collector status contracts", () => {
  const metrics = { discovered: 4, changed: 3, uploaded: 2, ignored: 1, unchanged: 0 }

  test("accepts only truthful processed and failed outcomes", () => {
    const base = { protocolVersion: 1, device: { id: "mac", name: "Studio Mac" } }
    expect(
      decodeExact(CollectorStatusV1Schema, {
        ...base,
        outcome: { status: "processed", metrics, error: null },
      }),
    ).toBeDefined()
    expect(
      decodeExact(CollectorStatusV1Schema, {
        ...base,
        outcome: { status: "failed", metrics: null, error: "collector_error" },
      }),
    ).toBeDefined()
    rejects(CollectorStatusV1Schema, {
      ...base,
      outcome: { status: "processed", metrics, error: "upload_error" },
    })
    rejects(CollectorStatusV1Schema, {
      ...base,
      outcome: { status: "failed", metrics, error: null },
    })
    rejects(CollectorStatusV1Schema, {
      ...base,
      outcome: { status: "failed", metrics: { ...metrics, uploaded: -1 }, error: "upload_error" },
    })
    rejects(CollectorStatusV1Schema, {
      ...base,
      outcome: { status: "failed", metrics, error: "private_path_error" },
    })
  })

  test("exact-decodes nullable machine freshness without an online guess", () => {
    const value = {
      protocolVersion: 1,
      generatedAt: "2026-08-04T12:00:00.000Z",
      machines: [
        {
          id: "mac",
          name: "Studio Mac",
          firstSeenAt: "2026-08-04T11:00:00.000Z",
          lastIngestedAt: null,
          lastCheckedAt: "2026-08-04T12:00:00.000Z",
          lastProcessedAt: null,
          lastError: "parse_error",
          metrics,
        },
      ],
    } as const
    expect(decodeExact(MachinesV1Schema, value)).toEqual(value)
    rejects(MachinesV1Schema, {
      ...value,
      machines: [{ ...value.machines[0], online: true }],
    })
  })
})

describe("summarization metadata contracts", () => {
  const metadata = {
    protocolVersion: 1,
    model: "@cf/model",
    prompts: { session: "Session prompt", day: "Day prompt" },
  } as const

  test("requires exact effective metadata and possible enabled states", () => {
    expect(decodeExact(SummarizationMetadataV1Schema, metadata)).toEqual(metadata)
    expect(
      decodeExact(SummarizationStatusV1Schema, { enabled: false, metadata: null }),
    ).toEqual({ enabled: false, metadata: null })
    expect(
      decodeExact(SummarizationStatusV1Schema, { enabled: true, metadata }),
    ).toEqual({ enabled: true, metadata })
    rejects(SummarizationStatusV1Schema, { enabled: true, metadata: null })
    rejects(SummarizationStatusV1Schema, { enabled: false, metadata })
    rejects(SummarizationMetadataV1Schema, {
      ...metadata,
      prompts: { ...metadata.prompts, session: " Session prompt" },
    })
    rejects(SummarizationMetadataV1Schema, { ...metadata, endpoint: "private" })
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
      changed(bootstrap(), (copy) => (copy.indexedAt = "2026-07-01T17:01:00Z")),
      changed(bootstrap(), (copy) => (copy.hubUrl = "")),
      changed(bootstrap(), (copy) => (copy.hubUrl = "h".repeat(2049))),
      changed(bootstrap(), (copy) => (copy.timezone = "Not/A_Zone")),
      changed(bootstrap(), (copy) => (copy.sessions[0].id = "")),
      changed(bootstrap(), (copy) => (copy.sessions[0].id = "i".repeat(65))),
      changed(bootstrap(), (copy) => (copy.sessions[0].machine.name = " padded ")),
      changed(bootstrap(), (copy) => (copy.sessions[0].cwd = "c".repeat(4097))),
      changed(bootstrap(), (copy) => (copy.sessions[0].firstPrompt = "p".repeat(241))),
      changed(bootstrap(), (copy) => (copy.preferences.boundary = 8)),
      changed(bootstrap(), (copy) => (copy.preferences.halo = 6)),
      changed(bootstrap(), (copy) => (copy.preferences.onboardingVersion = -1)),
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
    expect(decodeExact(SettingsPatchSchema, { onboardingVersion: 1 })).toEqual({ onboardingVersion: 1 })
    expect(decodeExact(SettingsPatchSchema, { timezone: "Europe/Rome" })).toEqual({ timezone: "Europe/Rome" })
    rejects(SettingsPatchSchema, { boundary: 3 })
    rejects(SettingsPatchSchema, { halo: 1 })
    rejects(SettingsPatchSchema, { onboardingVersion: 0 })
    rejects(SettingsPatchSchema, { onboardingVersion: 2 })
    rejects(SettingsPatchSchema, { timezone: " Not/A_Zone " })
    rejects(SettingsPatchSchema, { timezone: "Not/A_Zone" })
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
