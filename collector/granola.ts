import { Schema } from "effect"
import type { GranolaCaptureV1, IngestCaptureV1 } from "../shared/protocol"
import type { GranolaCollectorConfig } from "../cli/config"
import type { CaptureAdapter } from "./captures"

const PAGE_SIZE = 100
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024
const MAX_LIST_PAGES = 100
const MAX_ATTENTION_MINUTES = 10_080
const RESCAN_WINDOW_MS = 24 * 60 * 60 * 1_000
const CURSOR_PREFIX = "granola-v1/"
const CalendarEventSchema = Schema.NullOr(
  Schema.Struct({
    event_title: Schema.NullOr(Schema.String),
    invitees: Schema.Array(Schema.Unknown),
    organiser: Schema.NullOr(Schema.String),
    calendar_event_id: Schema.NullOr(Schema.String),
    scheduled_start_time: Schema.NullOr(Schema.String),
    scheduled_end_time: Schema.NullOr(Schema.String),
  }),
)

const ListNoteSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  type: Schema.Literal("meeting"),
  status: Schema.NullOr(Schema.String),
  owner: Schema.Unknown,
  calendar_event: CalendarEventSchema,
})

const ListResponseSchema = Schema.Struct({
  notes: Schema.Array(ListNoteSchema),
  has_more: Schema.Boolean,
  next_offset: Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.nonNegative())),
})

const DetailNoteSchema = Schema.Struct({
  ...ListNoteSchema.fields,
  notes_plain: Schema.NullOr(Schema.String),
  notes_markdown: Schema.NullOr(Schema.String),
  summary_text: Schema.NullOr(Schema.String),
  summary_markdown: Schema.NullOr(Schema.String),
})

const DetailResponseSchema = Schema.Struct({
  notes: Schema.Array(DetailNoteSchema),
  not_found: Schema.Array(Schema.String),
})

type ListResponse = Schema.Schema.Type<typeof ListResponseSchema>
type DetailNote = Schema.Schema.Type<typeof DetailNoteSchema>

export interface GranolaCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type GranolaCommandRunner = (
  binaryPath: string,
  args: ReadonlyArray<string>,
) => Promise<GranolaCommandResult>

export interface GranolaAdapterOptions {
  readonly run?: GranolaCommandRunner
  readonly now?: () => number
}

function canonicalTimestamp(value: string, field: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Granola ${field} is invalid`)
  return parsed.toISOString()
}

function validateNoteId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Granola note id is invalid")
  }
  return value
}

function decodeListResponse(input: unknown): ListResponse {
  try {
    const response = Schema.decodeUnknownSync(ListResponseSchema)(input)
    if (response.has_more && response.next_offset === null) {
      throw new Error("Granola local CLI pagination is incomplete")
    }
    for (const note of response.notes) {
      validateNoteId(note.id)
      canonicalTimestamp(note.created_at, "created_at")
      canonicalTimestamp(note.updated_at, "updated_at")
    }
    return response
  } catch (error) {
    if (error instanceof Error && error.message === "Granola local CLI pagination is incomplete") throw error
    throw new Error("Granola local CLI list response shape changed")
  }
}

function decodeDetailResponse(input: unknown, expectedId: string): DetailNote | null {
  let response: Schema.Schema.Type<typeof DetailResponseSchema>
  try {
    response = Schema.decodeUnknownSync(DetailResponseSchema)(input)
  } catch {
    throw new Error("Granola local CLI detail response shape changed")
  }
  if (response.not_found.includes(expectedId)) {
    if (response.notes.length !== 0) throw new Error("Granola local CLI detail response was inconsistent")
    return null
  }
  if (response.notes.length !== 1 || response.notes[0]?.id !== expectedId) {
    throw new Error("Granola local CLI detail note id did not match the list")
  }
  const note = response.notes[0]
  validateNoteId(note.id)
  canonicalTimestamp(note.created_at, "created_at")
  canonicalTimestamp(note.updated_at, "updated_at")
  return note
}

async function defaultCommandRunner(
  binaryPath: string,
  args: ReadonlyArray<string>,
): Promise<GranolaCommandResult> {
  const process = (() => {
    try {
      return Bun.spawn([binaryPath, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
    } catch {
      throw new Error("Granola local CLI could not be started")
    }
  })()
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

function commandErrorMessage(...outputs: ReadonlyArray<string>): string {
  for (const output of outputs) {
    try {
      const decoded: unknown = JSON.parse(output)
      if (typeof decoded !== "object" || decoded === null || !("error" in decoded)) continue
      const error = (decoded as { readonly error?: unknown }).error
      if (typeof error !== "object" || error === null || !("code" in error)) continue
      const code = (error as { readonly code?: unknown }).code
      if (code === "APP_NOT_RUNNING") return "Granola Desktop is not running or its Companion CLI is disabled"
      if (code === "UNAUTHENTICATED") return "Granola Desktop rejected Companion CLI authentication"
      if (code === "REQUEST_TIMEOUT") return "Granola Companion CLI timed out"
    } catch {
      // Never echo unparsed command output: it may contain local note data.
    }
  }
  return "command failed"
}

function scheduledInterval(note: DetailNote): { readonly start: string; readonly end: string } | null {
  const startValue = note.calendar_event?.scheduled_start_time
  const endValue = note.calendar_event?.scheduled_end_time
  if (!startValue || !endValue) return null
  let start: string
  let end: string
  try {
    start = canonicalTimestamp(startValue, "scheduled start")
    end = canonicalTimestamp(endValue, "scheduled end")
  } catch {
    return null
  }
  const startMinute = Math.floor(Date.parse(start) / 60_000)
  const endMinute = Math.ceil(Date.parse(end) / 60_000)
  return endMinute > startMinute && endMinute - startMinute <= MAX_ATTENTION_MINUTES ? { start, end } : null
}

function attentionFor(
  note: DetailNote,
  interval: { readonly start: string; readonly end: string } | null,
): ReadonlyArray<number> {
  if (!interval) return [Math.floor(Date.parse(canonicalTimestamp(note.created_at, "created_at")) / 60_000)]

  const minutes: number[] = []
  const start = Math.floor(Date.parse(interval.start) / 60_000)
  const end = Math.ceil(Date.parse(interval.end) / 60_000)
  for (let utcMinute = start; utcMinute < end; utcMinute++) minutes.push(utcMinute)
  return minutes
}

function truncateBounded(value: string, maximum: number): string {
  let truncated = value.slice(0, maximum)
  const lastCodeUnit = truncated.charCodeAt(truncated.length - 1)
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) truncated = truncated.slice(0, -1)
  return truncated.trimEnd()
}
function boundedTitle(value: string | null): string {
  return truncateBounded(value?.trim() || "Untitled meeting", 200)
}
function boundedSummary(note: DetailNote): string | null {
  const candidates = [note.summary_text, note.summary_markdown, note.notes_plain, note.notes_markdown]
  const summary = candidates.map((value) => value?.trim() ?? "").find(Boolean) ?? ""
  return summary ? truncateBounded(summary, 12_000) : null
}

function decodeCursor(cursor: string | null, initial: string): string {
  if (cursor === null) return initial
  const [prefix, configuredInitial, collectedAt, extra] = cursor.split("/")
  if (`${prefix}/` !== CURSOR_PREFIX || !configuredInitial || !collectedAt || extra !== undefined) {
    throw new Error("Granola cursor shape changed")
  }
  const decodedInitial = canonicalTimestamp(configuredInitial, "cursor initial")
  const decodedCollectedAt = canonicalTimestamp(collectedAt, "cursor collection time")
  return decodedInitial === initial ? decodedCollectedAt : initial
}

function encodeCursor(initial: string, collectedAt: string): string {
  return `${CURSOR_PREFIX}${initial}/${collectedAt}`
}

export function normalizeGranolaNote(note: DetailNote): GranolaCaptureV1 | null {
  const summaryInput = boundedSummary(note)
  if (!summaryInput) return null
  const interval = scheduledInterval(note)
  const createdAt = canonicalTimestamp(note.created_at, "created_at")
  return {
    source: "granola",
    sourceRecordId: validateNoteId(note.id),
    project: null,
    projectHint: null,
    title: boundedTitle(note.title),
    startedAt: interval?.start ?? createdAt,
    endedAt: interval?.end ?? null,
    summaryInput,
    attentionMinutes: attentionFor(note, interval),
    payload: {
      attendeeCount: Math.min(note.calendar_event?.invitees.length ?? 0, 10_000),
    },
    images: [],
  }
}

export class GranolaAdapter implements CaptureAdapter {
  readonly source = "granola" as const
  private readonly run: GranolaCommandRunner
  private readonly now: () => number

  constructor(
    private readonly config: GranolaCollectorConfig,
    options: GranolaAdapterOptions = {},
  ) {
    this.run = options.run ?? defaultCommandRunner
    this.now = options.now ?? Date.now
  }

  private async runJson(args: ReadonlyArray<string>, operation: string): Promise<unknown> {
    const result = await this.run(this.config.binaryPath, args)
    if (Buffer.byteLength(result.stdout) > MAX_COMMAND_OUTPUT_BYTES) {
      throw new Error(`Granola local CLI ${operation} output exceeded 2 MiB`)
    }
    if (result.exitCode !== 0) {
      throw new Error(`Granola local CLI ${operation} failed: ${commandErrorMessage(result.stderr, result.stdout)}`)
    }
    try {
      return JSON.parse(result.stdout) as unknown
    } catch {
      throw new Error(`Granola local CLI ${operation} returned malformed JSON`)
    }
  }

  async collect(cursor: string | null): Promise<{
    readonly captures: ReadonlyArray<IngestCaptureV1>
    readonly nextCursor: string | null
  }> {
    const initial = canonicalTimestamp(this.config.initialCreatedAfter, "created-after")
    const startedAt = canonicalTimestamp(new Date(this.now()).toISOString(), "collection time")
    const previous = decodeCursor(cursor, initial)
    const lookback = new Date(Math.max(Date.parse(initial), Date.parse(previous) - RESCAN_WINDOW_MS)).toISOString()
    const notes: ListResponse["notes"][number][] = []
    const noteIds = new Set<string>()
    const offsets = new Set<number>()
    let offset = 0
    let pageCount = 0
    while (true) {
      pageCount++
      if (pageCount > MAX_LIST_PAGES) throw new Error("Granola local CLI pagination did not terminate")
      const page = decodeListResponse(
        await this.runJson(
          ["notes", "list", "--created-after", lookback, "--limit", String(PAGE_SIZE), "--offset", String(offset)],
          "list",
        ),
      )
      for (const note of page.notes) {
        if (noteIds.has(note.id)) throw new Error("Granola local CLI repeated a note id")
        noteIds.add(note.id)
        notes.push(note)
      }
      if (!page.has_more) break
      if (page.next_offset === null || page.next_offset <= offset || offsets.has(page.next_offset)) {
        throw new Error("Granola local CLI pagination did not advance")
      }
      offsets.add(page.next_offset)
      offset = page.next_offset
    }

    const captures: IngestCaptureV1[] = []
    for (const listed of notes) {
      const detail = decodeDetailResponse(
        await this.runJson(["notes", "get", "--id", listed.id], "detail"),
        listed.id,
      )
      if (!detail) continue
      const capture = normalizeGranolaNote(detail)
      if (capture) captures.push(capture)
    }
    return {
      captures,
      nextCursor: encodeCursor(initial, startedAt > previous ? startedAt : previous),
    }
  }
}
