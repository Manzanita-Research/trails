import { Schema } from "effect"
import type { ActivityTuple, Source } from "./domain"

const boundedString = (minimum: number, maximum: number) =>
  Schema.String.pipe(Schema.minLength(minimum), Schema.maxLength(maximum))

const trimmedString = (minimum: number, maximum: number) =>
  boundedString(minimum, maximum).pipe(
    Schema.filter((value) => value === value.trim() || "must be trimmed"),
  )

const nullableBoundedString = (maximum: number) => Schema.NullOr(Schema.String.pipe(Schema.maxLength(maximum)))

export const SourceSchema = Schema.Literal("claude", "codex", "omp", "pi")
export const CanonicalTimestampSchema = Schema.String.pipe(
  Schema.filter((value) => {
    const parsed = new Date(value)
    return (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) || "must be canonical UTC milliseconds"
  }),
)
export const LocalDateSchema = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.filter((value) => {
    const parsed = new Date(`${value}T12:00:00Z`)
    return (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) || "must be a calendar date"
  }),
)

export const ActivityTupleSchema = Schema.Tuple(
  LocalDateSchema,
  Schema.Number.pipe(Schema.int(), Schema.between(0, 1439)),
  Schema.Number.pipe(Schema.int(), Schema.positive()),
  Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
).pipe(
  Schema.filter((tuple) => tuple[3] <= tuple[2] || "user event count exceeds event count"),
)

const ActivitySchema = Schema.Array(ActivityTupleSchema).pipe(
  Schema.minItems(1),
  Schema.filter((activity) => {
    let previous = ""
    for (const [date, minute] of activity) {
      const key = `${date}:${String(minute).padStart(4, "0")}`
      if (key <= previous) return "activity tuples must be unique and sorted"
      previous = key
    }
    return true
  }),
)

export const IngestSessionV1Schema = Schema.Struct({
  sourceSessionId: boundedString(1, 256),
  source: SourceSchema,
  cwd: nullableBoundedString(4096),
  branch: nullableBoundedString(4096),
  start: CanonicalTimestampSchema,
  end: CanonicalTimestampSchema,
  events: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(2)),
  userEvents: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  firstPrompt: nullableBoundedString(240),
  activity: ActivitySchema,
  digest: nullableBoundedString(9000),
}).pipe(
  Schema.filter((session) => {
    if (session.start > session.end) return "start must not be after end"
    if (session.userEvents > session.events) return "userEvents exceeds events"
    let events = 0
    let userEvents = 0
    for (const tuple of session.activity) {
      events += tuple[2]
      userEvents += tuple[3]
    }
    return (events === session.events && userEvents === session.userEvents) || "activity totals do not match session totals"
  }),
)

export const DeviceV1Schema = Schema.Struct({
  id: trimmedString(1, 128),
  name: trimmedString(1, 128),
})

export const IngestRequestV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  device: DeviceV1Schema,
  sessions: Schema.Array(IngestSessionV1Schema).pipe(Schema.minItems(1), Schema.maxItems(50)),
})

export const BootstrapSessionV1Schema = Schema.Struct({
  id: boundedString(1, 64),
  machine: DeviceV1Schema,
  source: SourceSchema,
  cwd: nullableBoundedString(4096),
  branch: nullableBoundedString(4096),
  start: CanonicalTimestampSchema,
  end: CanonicalTimestampSchema,
  events: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(2)),
  userEvents: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  firstPrompt: nullableBoundedString(240),
  activity: ActivitySchema,
})

const StringRecordSchema = Schema.Record({ key: Schema.String, value: Schema.String })

export const PreferencesV1Schema = Schema.Struct({
  boundary: Schema.Literal(4, 5, 6, 7),
  halo: Schema.Literal(0, 5, 10, 15),
  onboardingVersion: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  assignments: StringRecordSchema,
  customEngagements: Schema.Array(
    Schema.Struct({ id: trimmedString(1, 128), name: trimmedString(1, 80) }),
  ),
  names: StringRecordSchema,
  pocket: Schema.Array(
    Schema.Struct({
      id: trimmedString(1, 128),
      text: trimmedString(1, 500),
      at: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
    }),
  ),
})

export const BootstrapV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  generatedAt: CanonicalTimestampSchema,
  indexedAt: Schema.NullOr(CanonicalTimestampSchema),
  hubUrl: trimmedString(1, 2048),
  timezone: Schema.Literal("America/Los_Angeles"),
  sessions: Schema.Array(BootstrapSessionV1Schema),
  summaries: Schema.Struct({ sessions: StringRecordSchema, days: StringRecordSchema }),
  preferences: PreferencesV1Schema,
})

export const SettingsPatchSchema = Schema.Struct({
  boundary: Schema.optional(Schema.Literal(4, 5, 6, 7)),
  halo: Schema.optional(Schema.Literal(0, 5, 10, 15)),
  onboardingVersion: Schema.optional(Schema.Literal(1)),
})

export const ProjectPatchSchema = Schema.Struct({
  project: trimmedString(1, 4096),
  engagementId: Schema.optional(Schema.NullOr(trimmedString(1, 4096))),
  displayName: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(80)))),
})

export const EngagementCreateSchema = Schema.Struct({ name: trimmedString(1, 80) })
export const PocketCreateSchema = Schema.Struct({ text: trimmedString(1, 500) })

export type IngestSessionV1 = Schema.Schema.Type<typeof IngestSessionV1Schema> & {
  readonly source: Source
  readonly activity: ReadonlyArray<ActivityTuple>
}
export type IngestRequestV1 = Schema.Schema.Type<typeof IngestRequestV1Schema> & {
  readonly sessions: ReadonlyArray<IngestSessionV1>
}
export type BootstrapSessionV1 = Schema.Schema.Type<typeof BootstrapSessionV1Schema>
export type PreferencesV1 = Schema.Schema.Type<typeof PreferencesV1Schema>
export type BootstrapV1 = Schema.Schema.Type<typeof BootstrapV1Schema>
export type SettingsPatch = Schema.Schema.Type<typeof SettingsPatchSchema>
export type ProjectPatch = Schema.Schema.Type<typeof ProjectPatchSchema>
export type EngagementCreate = Schema.Schema.Type<typeof EngagementCreateSchema>
export type PocketCreate = Schema.Schema.Type<typeof PocketCreateSchema>

export function decodeExact<S extends Schema.Schema.AnyNoContext>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
}

export function encodeExact<S extends Schema.Schema.AnyNoContext>(schema: S, value: Schema.Schema.Type<S>): unknown {
  return Schema.encodeSync(schema)(value)
}
