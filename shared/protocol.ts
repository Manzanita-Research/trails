import { Schema } from "effect"
import type { LocalActivityTuple, Source, UtcActivityTuple } from "./domain"
import { INGEST_LIMITS } from "./limits"
import { HARNESS_IDS } from "./harnesses"
import { CAPTURE_IMAGE_MAX_BYTES, CAPTURE_IMAGE_MAX_DIMENSION, CAPTURE_IMAGE_MAX_PIXELS } from "./capture-image-limits"

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

export const LocalActivityTupleSchema = Schema.Tuple(
  LocalDateSchema,
  Schema.Number.pipe(Schema.int(), Schema.between(0, 1439)),
  Schema.Number.pipe(Schema.int(), Schema.positive()),
  Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
).pipe(
  Schema.filter((tuple) => tuple[3] <= tuple[2] || "user event count exceeds event count"),
)

const LocalActivitySchema = Schema.Array(LocalActivityTupleSchema).pipe(
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

export const UtcActivityTupleSchema = Schema.Tuple(
  Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  Schema.Number.pipe(Schema.int(), Schema.positive()),
  Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
).pipe(
  Schema.filter((tuple) => tuple[2] <= tuple[1] || "user event count exceeds event count"),
)

const UtcActivitySchema = Schema.Array(UtcActivityTupleSchema).pipe(
  Schema.minItems(1),
  Schema.maxItems(INGEST_LIMITS.sessionTuples),
  Schema.filter((activity) => {
    if (activity.at(-1)![0] - activity[0][0] > INGEST_LIMITS.spanMinutes) return "activity span exceeds 31 days"
    let previous = -1
    for (const [utcMinute] of activity) {
      if (utcMinute <= previous) return "activity tuples must be unique and sorted"
      previous = utcMinute
    }
    return true
  }),
)

export const CaptureSourceV1Schema = Schema.Literal("midjourney", "granola")

export const CaptureAttentionTupleV1Schema = Schema.Tuple(
  LocalDateSchema,
  Schema.Number.pipe(Schema.int(), Schema.between(0, 1439)),
)

const CaptureAttentionV1Schema = Schema.Array(CaptureAttentionTupleV1Schema).pipe(
  Schema.minItems(1),
  Schema.maxItems(10_080),
  Schema.filter((attention) => {
    let previous = ""
    for (const [date, minute] of attention) {
      const key = `${date}:${String(minute).padStart(4, "0")}`
      if (key <= previous) return "attention tuples must be unique and sorted"
      previous = key
    }
    return true
  }),
)

const CaptureUtcAttentionV1Schema = Schema.Array(
  Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
).pipe(
  Schema.minItems(1),
  Schema.maxItems(INGEST_LIMITS.sessionTuples),
  Schema.filter((attention) => {
    if (attention.at(-1)! - attention[0] > INGEST_LIMITS.spanMinutes) return "attention span exceeds 31 days"
    let previous = -1
    for (const utcMinute of attention) {
      if (utcMinute <= previous) return "attention minutes must be unique and sorted"
      previous = utcMinute
    }
    return true
  }),
)

const strictBase64 = Schema.String.pipe(
  Schema.minLength(4),
  Schema.maxLength(Math.ceil(CAPTURE_IMAGE_MAX_BYTES / 3) * 4),
  Schema.filter((value) => {
    if (
      value.startsWith("data:") ||
      value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
      return "must be raw canonical base64"
    }
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
    return (value.length / 4) * 3 - padding <= CAPTURE_IMAGE_MAX_BYTES || "decoded image exceeds 500 KiB"
  }),
)

export const CaptureImageV1Schema = Schema.Struct({
  index: Schema.Number.pipe(Schema.int(), Schema.between(0, 3)),
  mime: Schema.Literal("image/jpeg", "image/png", "image/webp"),
  width: Schema.Number.pipe(Schema.int(), Schema.between(1, CAPTURE_IMAGE_MAX_DIMENSION)),
  height: Schema.Number.pipe(Schema.int(), Schema.between(1, CAPTURE_IMAGE_MAX_DIMENSION)),
  bytes: strictBase64,
}).pipe(Schema.filter((image) => image.width * image.height <= CAPTURE_IMAGE_MAX_PIXELS || "image exceeds pixel limit"))

const MidjourneyImagesV1Schema = Schema.Array(CaptureImageV1Schema).pipe(
  Schema.itemsCount(4),
  Schema.filter(
    (images) =>
      images.every((image, index) => image.index === index) ||
      "Midjourney images must contain indexes 0 through 3 in order",
  ),
)

const GranolaImagesV1Schema = Schema.Array(CaptureImageV1Schema).pipe(Schema.itemsCount(0))

const CaptureCommonV1Fields = {
  sourceRecordId: trimmedString(1, 128),
  project: Schema.NullOr(trimmedString(1, 4096)),
  projectHint: Schema.NullOr(trimmedString(1, 200)),
  title: trimmedString(1, 200),
  startedAt: CanonicalTimestampSchema,
  endedAt: Schema.NullOr(CanonicalTimestampSchema),
  summaryInput: trimmedString(1, 12_000),
  attentionMinutes: CaptureUtcAttentionV1Schema,
}

const MidjourneyCapturePayloadV1Schema = Schema.Struct({
  eventType: trimmedString(1, 100),
  jobType: trimmedString(1, 100),
  parentSourceRecordId: Schema.NullOr(trimmedString(1, 128)),
  parentGrid: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(0, 3))),
})

const GranolaNoteUrlSchema = boundedString(1, 2048).pipe(
  Schema.filter((value) => {
    try {
      const url = new URL(value)
      const granolaHost = url.hostname === "granola.ai" || url.hostname.endsWith(".granola.ai")
      return (url.protocol === "https:" && granolaHost) || "must be an HTTPS Granola URL"
    } catch {
      return "must be an HTTPS Granola URL"
    }
  }),
)

const GranolaFoldersV1Schema = Schema.Array(trimmedString(1, 200)).pipe(
  Schema.maxItems(50),
  Schema.filter((folders) => new Set(folders).size === folders.length || "folder names must be unique"),
)

const GranolaCapturePayloadV1Schema = Schema.Struct({
  attendeeCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 10_000)),
  folders: GranolaFoldersV1Schema,
  webUrl: Schema.NullOr(GranolaNoteUrlSchema),
})

const validCaptureInterval = <A extends { readonly startedAt: string; readonly endedAt: string | null }>(
  capture: A,
): boolean | string =>
  capture.endedAt === null ||
  (capture.endedAt >= capture.startedAt && Date.parse(capture.endedAt) - Date.parse(capture.startedAt) <= INGEST_LIMITS.spanMinutes * 60_000) ||
  "capture interval must be ordered and at most 31 days"

export const MidjourneyCaptureV1Schema = Schema.Struct({
  ...CaptureCommonV1Fields,
  source: Schema.Literal("midjourney"),
  payload: MidjourneyCapturePayloadV1Schema,
  images: MidjourneyImagesV1Schema,
}).pipe(Schema.filter(validCaptureInterval))

export const GranolaCaptureV1Schema = Schema.Struct({
  ...CaptureCommonV1Fields,
  source: Schema.Literal("granola"),
  payload: GranolaCapturePayloadV1Schema,
  images: GranolaImagesV1Schema,
}).pipe(Schema.filter(validCaptureInterval))

export const IngestCaptureV1Schema = Schema.Union(MidjourneyCaptureV1Schema, GranolaCaptureV1Schema)


export const IngestSessionV2Schema = Schema.Struct({
  sourceSessionId: boundedString(1, 256),
  source: SourceSchema,
  cwd: nullableBoundedString(4096),
  branch: nullableBoundedString(4096),
  start: CanonicalTimestampSchema,
  end: CanonicalTimestampSchema,
  events: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(2)),
  userEvents: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  firstPrompt: nullableBoundedString(240),
  activity: UtcActivitySchema,
  digest: nullableBoundedString(9000),
}).pipe(
  Schema.filter((session) => {
    if (Date.parse(session.end) - Date.parse(session.start) > INGEST_LIMITS.spanMinutes * 60_000) return "session span exceeds 31 days"
    if (session.start > session.end) return "start must not be after end"
    if (session.userEvents > session.events) return "userEvents exceeds events"
    let events = 0
    let userEvents = 0
    for (const tuple of session.activity) {
      events += tuple[1]
      userEvents += tuple[2]
    }
    return (events === session.events && userEvents === session.userEvents) || "activity totals do not match session totals"
  }),
)

export const DeviceV1Schema = Schema.Struct({
  id: trimmedString(1, 128),
  name: trimmedString(1, 128),
})

export const IngestRequestV2Schema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  device: DeviceV1Schema,
  sessions: Schema.Array(IngestSessionV2Schema).pipe(Schema.minItems(1), Schema.maxItems(50)),
}).pipe(Schema.filter(body => body.sessions.reduce((sum, session) => sum + session.activity.length, 0) <= INGEST_LIMITS.batchTuples || "batch tuple limit exceeded"))
export const CollectionMetricsV1Schema = Schema.Struct({
  discovered: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  changed: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  uploaded: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  ignored: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  unchanged: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})

export const CollectorErrorCodeSchema = Schema.Literal(
  "parse_error",
  "file_changed_during_read",
  "upload_error",
  "collector_error",
)

export const CollectorStatusV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  device: DeviceV1Schema,
  outcome: Schema.Union(
    Schema.Struct({
      status: Schema.Literal("processed"),
      metrics: CollectionMetricsV1Schema,
      error: Schema.Null,
    }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      metrics: Schema.NullOr(CollectionMetricsV1Schema),
      error: CollectorErrorCodeSchema,
    }),
  ),
})
export const IngestCapturesRequestV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  device: DeviceV1Schema,
  captures: Schema.Array(IngestCaptureV1Schema).pipe(Schema.minItems(1), Schema.maxItems(20)),
}).pipe(Schema.filter(body => body.captures.reduce((sum, capture) => sum + capture.attentionMinutes.length, 0) <= INGEST_LIMITS.batchTuples || "batch tuple limit exceeded"))

export const MachineStatusV1Schema = Schema.Struct({
  id: trimmedString(1, 128),
  name: trimmedString(1, 128),
  firstSeenAt: CanonicalTimestampSchema,
  lastIngestedAt: Schema.NullOr(CanonicalTimestampSchema),
  lastCheckedAt: Schema.NullOr(CanonicalTimestampSchema),
  lastProcessedAt: Schema.NullOr(CanonicalTimestampSchema),
  lastError: Schema.NullOr(CollectorErrorCodeSchema),
  metrics: Schema.NullOr(CollectionMetricsV1Schema),
})

export const MachinesV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  generatedAt: CanonicalTimestampSchema,
  machines: Schema.Array(MachineStatusV1Schema),
})
export const HarnessIdSchema = Schema.Literal(...HARNESS_IDS)
export const HarnessSelectionSchema = Schema.Literal("auto", ...HARNESS_IDS)
export const SummarizationMetadataV2Schema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  harness: HarnessIdSchema,
  prompts: Schema.Struct({
    session: trimmedString(1, 4_000),
    day: trimmedString(1, 4_000),
  }),
})

export const SummarizationStatusV2Schema = Schema.Union(
  Schema.Struct({
    enabled: Schema.Literal(false),
    metadata: Schema.Null,
  }),
  Schema.Struct({
    enabled: Schema.Literal(true),
    metadata: SummarizationMetadataV2Schema,
  }),
)

export const SummarizeErrorClassSchema = Schema.Literal(
  "auth_required",
  "quota",
  "harness_failed",
  "timeout",
  "protocol",
)
export const HarnessStatusV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  harnesses: Schema.Array(Schema.Struct({
    id: HarnessIdSchema,
    label: trimmedString(1, 80),
    available: Schema.Boolean,
  })),
  active: Schema.NullOr(Schema.Struct({
    selection: HarnessSelectionSchema,
    harness: Schema.NullOr(HarnessIdSchema),
    state: Schema.Literal("unavailable", "never_ran", "ok", "failing"),
    lastAttemptAt: Schema.NullOr(Schema.Number.pipe(Schema.nonNegative())),
    lastSuccessAt: Schema.NullOr(Schema.Number.pipe(Schema.nonNegative())),
    lastErrorClass: Schema.NullOr(SummarizeErrorClassSchema),
  })),
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
  activity: LocalActivitySchema,
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

export const TimeZoneSchema = trimmedString(1, 100).pipe(
  Schema.filter((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value })
      return true
    } catch {
      return "must be an IANA time zone"
    }
  }),
)

export const BootstrapCaptureImageV1Schema = Schema.Struct({
  index: Schema.Number.pipe(Schema.int(), Schema.between(0, 3)),
  mime: Schema.Literal("image/jpeg", "image/png", "image/webp"),
  width: Schema.Number.pipe(Schema.int(), Schema.between(1, 16_384)),
  height: Schema.Number.pipe(Schema.int(), Schema.between(1, 16_384)),
  byteLength: Schema.Number.pipe(Schema.int(), Schema.between(1, 500 * 1024)),
  url: boundedString(1, 512),
})

const BootstrapCaptureCommonV1Fields = {
  id: boundedString(1, 64),
  project: Schema.NullOr(trimmedString(1, 4096)),
  projectHint: Schema.NullOr(trimmedString(1, 200)),
  title: trimmedString(1, 200),
  startedAt: CanonicalTimestampSchema,
  endedAt: Schema.NullOr(CanonicalTimestampSchema),
  summaryInput: trimmedString(1, 12_000),
  attentionMinutes: CaptureAttentionV1Schema,
  updatedAt: CanonicalTimestampSchema,
  images: Schema.Array(BootstrapCaptureImageV1Schema).pipe(Schema.maxItems(4)),
}

export const BootstrapMidjourneyCaptureV1Schema = Schema.Struct({
  ...BootstrapCaptureCommonV1Fields,
  source: Schema.Literal("midjourney"),
  payload: Schema.Struct({
    eventType: trimmedString(1, 100),
    jobType: trimmedString(1, 100),
    parentGrid: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(0, 3))),
    hasParent: Schema.Boolean,
    parentCaptureId: Schema.NullOr(boundedString(1, 64)),
  }),
})

export const BootstrapGranolaCaptureV1Schema = Schema.Struct({
  ...BootstrapCaptureCommonV1Fields,
  source: Schema.Literal("granola"),
  payload: GranolaCapturePayloadV1Schema,
})

export const BootstrapCaptureV1Schema = Schema.Union(
  BootstrapMidjourneyCaptureV1Schema,
  BootstrapGranolaCaptureV1Schema,
)

export const BootstrapV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  revision: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  generatedAt: CanonicalTimestampSchema,
  indexedAt: Schema.NullOr(CanonicalTimestampSchema),
  hubUrl: trimmedString(1, 2048),
  timezone: TimeZoneSchema,
  sessions: Schema.Array(BootstrapSessionV1Schema),
  captures: Schema.Array(BootstrapCaptureV1Schema),
  summaries: Schema.Struct({ sessions: StringRecordSchema, days: StringRecordSchema }),
  preferences: PreferencesV1Schema,
})

export const SettingsPatchSchema = Schema.Struct({
  boundary: Schema.optional(Schema.Literal(4, 5, 6, 7)),
  halo: Schema.optional(Schema.Literal(0, 5, 10, 15)),
  onboardingVersion: Schema.optional(Schema.Literal(1)),
  timezone: Schema.optional(TimeZoneSchema),
})
export const ProjectPatchSchema = Schema.Struct({
  project: trimmedString(1, 4096),
  engagementId: Schema.optional(Schema.NullOr(trimmedString(1, 4096))),
  displayName: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(80)))),
})

export const EngagementCreateSchema = Schema.Struct({ name: trimmedString(1, 80) })
export const PocketCreateSchema = Schema.Struct({ text: trimmedString(1, 500) })

const FeedbackSourceCountsV1Schema = Schema.Struct({
  claude: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  codex: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  omp: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  pi: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
})

const FeedbackContextV1Schema = Schema.Struct({
  appVersion: trimmedString(1, 40),
  view: Schema.Literal("loading", "hub-error", "welcome", "days", "week", "threads", "project", "settings"),
  revision: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
  workDate: Schema.NullOr(LocalDateSchema),
  sourceCounts: Schema.NullOr(FeedbackSourceCountsV1Schema),
  viewport: Schema.Struct({
    width: Schema.Number.pipe(Schema.int(), Schema.between(1, 10_000)),
    height: Schema.Number.pipe(Schema.int(), Schema.between(1, 10_000)),
  }),
  syncError: Schema.Boolean,
})

export const FeedbackSubmissionV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  id: Schema.UUID,
  kind: Schema.Literal("confusing", "broken", "idea", "delight"),
  message: trimmedString(1, 2_000),
  followUp: Schema.NullOr(trimmedString(1, 200)),
  createdAt: CanonicalTimestampSchema,
  context: Schema.NullOr(FeedbackContextV1Schema),
})

export const FeedbackReceiptV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  id: Schema.UUID,
  status: Schema.Literal("received"),
})

export type IngestSessionV2 = Schema.Schema.Type<typeof IngestSessionV2Schema> & {
  readonly source: Source
  readonly activity: ReadonlyArray<UtcActivityTuple>
}
export type IngestRequestV2 = Schema.Schema.Type<typeof IngestRequestV2Schema> & {
  readonly sessions: ReadonlyArray<IngestSessionV2>
}
export type BootstrapSessionV1 = Schema.Schema.Type<typeof BootstrapSessionV1Schema> & {
  readonly activity: ReadonlyArray<LocalActivityTuple>
}
export type CaptureSourceV1 = Schema.Schema.Type<typeof CaptureSourceV1Schema>
export type CaptureAttentionTupleV1 = Schema.Schema.Type<typeof CaptureAttentionTupleV1Schema>
export type CaptureImageV1 = Schema.Schema.Type<typeof CaptureImageV1Schema>
export type MidjourneyCaptureV1 = Schema.Schema.Type<typeof MidjourneyCaptureV1Schema>
export type GranolaCaptureV1 = Schema.Schema.Type<typeof GranolaCaptureV1Schema>
export type IngestCaptureV1 = Schema.Schema.Type<typeof IngestCaptureV1Schema>
export type IngestCapturesRequestV1 = Schema.Schema.Type<typeof IngestCapturesRequestV1Schema> & {
  readonly captures: ReadonlyArray<IngestCaptureV1>
}
export type BootstrapCaptureImageV1 = Schema.Schema.Type<typeof BootstrapCaptureImageV1Schema>
export type BootstrapCaptureV1 = Schema.Schema.Type<typeof BootstrapCaptureV1Schema>
export type PreferencesV1 = Schema.Schema.Type<typeof PreferencesV1Schema>
export type BootstrapV1 = Schema.Schema.Type<typeof BootstrapV1Schema>
export type SettingsPatch = Schema.Schema.Type<typeof SettingsPatchSchema>
export type ProjectPatch = Schema.Schema.Type<typeof ProjectPatchSchema>
export type EngagementCreate = Schema.Schema.Type<typeof EngagementCreateSchema>
export type CollectionMetricsV1 = Schema.Schema.Type<typeof CollectionMetricsV1Schema>
export type CollectorErrorCode = Schema.Schema.Type<typeof CollectorErrorCodeSchema>
export type CollectorStatusV1 = Schema.Schema.Type<typeof CollectorStatusV1Schema>
export type MachineStatusV1 = Schema.Schema.Type<typeof MachineStatusV1Schema>
export type MachinesV1 = Schema.Schema.Type<typeof MachinesV1Schema>
export type SummarizationMetadataV2 = Schema.Schema.Type<typeof SummarizationMetadataV2Schema>
export type SummarizationStatusV2 = Schema.Schema.Type<typeof SummarizationStatusV2Schema>
export type HarnessStatusV1 = Schema.Schema.Type<typeof HarnessStatusV1Schema>
export type PocketCreate = Schema.Schema.Type<typeof PocketCreateSchema>
export type FeedbackSubmissionV1 = Schema.Schema.Type<typeof FeedbackSubmissionV1Schema>
export type FeedbackReceiptV1 = Schema.Schema.Type<typeof FeedbackReceiptV1Schema>

export function decodeExact<S extends Schema.Schema.AnyNoContext>(schema: S, input: unknown): Schema.Schema.Type<S> {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input)
}

export function encodeExact<S extends Schema.Schema.AnyNoContext>(schema: S, value: Schema.Schema.Type<S>): unknown {
  return Schema.encodeSync(schema)(value)
}
