import { createAuthentication, credentialFor, type Credential } from "./auth"
import { Effect, Schema } from "effect"
import { basename, join, resolve, sep } from "node:path"
import { localActivityOf, orgOf, type LocalActivityTuple, type UtcActivityTuple } from "../shared/domain"
import { DAY_SYSTEM, SESSION_SYSTEM } from "../shared/prompts"
import type { HarnessId, HarnessSelection } from "../shared/harnesses"
import {
  BootstrapV1Schema,
  CollectorStatusV1Schema,
  EngagementCreateSchema,
  IngestCapturesRequestV1Schema,
  IngestRequestV2Schema,
  MachinesV1Schema,
  HarnessSelectionSchema,
  SummarizationStatusV2Schema,
  PocketCreateSchema,
  ProjectPatchSchema,
  SettingsPatchSchema,
  decodeExact,
  encodeExact,
  type BootstrapCaptureV1,
  type BootstrapSessionV1,
  type BootstrapV1,
  type CaptureAttentionTupleV1,
  type MachinesV1,
} from "../shared/protocol"
import type { TrailsDb } from "./db"
import { ingestCaptures } from "./captures"
import { ingestSessions } from "./ingest"
import { rebuildDaySummaryJobs } from "./day-jobs"
import { createRequestBoundary, localOrigins } from "./request-boundary"

import type { HarnessControl } from "./harnesses/control"

export interface SummarizationDescriber {
  describe(): { readonly selection: HarnessSelection; readonly harness: HarnessId | null } | null
}

const SummarizerSelectionBodySchema = Schema.NullOr(
  Schema.Struct({
    harness: HarnessSelectionSchema,
  }),
)

export interface AppOptions {
  readonly db: TrailsDb
  readonly trustedOrigins?: readonly string[]
  readonly staticRoot?: string
  readonly staticAssets?: ReadonlyArray<Blob & { readonly name: string }>
  readonly summarization?: SummarizationDescriber
  readonly harnesses?: HarnessControl
  readonly now?: () => number
}

type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "untrusted_host"
  | "untrusted_origin"
  | "invalid_json"
  | "invalid_request"
  | "unsupported_protocol"
  | "payload_too_large"
  | "upstream_unavailable"
  | "not_found"
  | "internal_error"
  | "method_not_allowed"

class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

// Private responses have zero HTTP cache retention, including conditional responses and errors.
// Keep this policy at the API boundary so bodyless/status responses inherit it too.
const privateCacheControl = "no-store"
const jsonHeaders = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": privateCacheControl }

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders })
}

function errorResponse(error: ApiError): Response {
  return jsonResponse({ error: { code: error.code, message: error.message } }, error.status)
}

function revisionOf(db: TrailsDb): number {
  const row = db.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get() as { value: string }
  return Number(row.value)
}

function incrementRevision(db: TrailsDb): number {
  const revision = revisionOf(db) + 1
  db.sqlite.query("UPDATE meta SET value = ? WHERE key = 'state_revision'").run(String(revision))
  return revision
}

export function setAdvertisedHubUrl(db: TrailsDb, hubUrl: string): number {
  return db.sqlite.transaction(() => {
    const current = db.sqlite.query("SELECT hub_url FROM settings WHERE id = 1").get() as { hub_url: string }
    if (current.hub_url === hubUrl) return revisionOf(db)
    db.sqlite.query("UPDATE settings SET hub_url = ? WHERE id = 1").run(hubUrl)
    return incrementRevision(db)
  })()
}

async function readJson(request: Request, maximumBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  if (contentType !== "application/json") throw new ApiError("invalid_request", "Content-Type must be application/json", 400)
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ApiError("payload_too_large", "request body is too large", 413)
  }
  if (!request.body) throw new ApiError("invalid_json", "request body is required", 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    length += result.value.byteLength
    if (length > maximumBytes) {
      await reader.cancel()
      throw new ApiError("payload_too_large", "request body is too large", 413)
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw new ApiError("invalid_json", "request body is not valid JSON", 400)
  }
}

function decodeBody<S extends Schema.Schema.AnyNoContext>(schema: S, input: unknown): Schema.Schema.Type<S> {
  try {
    return decodeExact(schema, input)
  } catch {
    throw new ApiError("invalid_request", "request body failed validation", 400)
  }
}

function activitiesBySession(db: TrailsDb, timezone: string): Map<number, LocalActivityTuple[]> {
  const rows = db.sqlite
    .query(
      "SELECT session_id, utc_minute, event_count, user_event_count FROM session_activity ORDER BY session_id, utc_minute",
    )
    .all() as Array<{
    session_id: number
    utc_minute: number
    event_count: number
    user_event_count: number
  }>
  const utcBySession = new Map<number, UtcActivityTuple[]>()
  for (const row of rows) {
    let activity = utcBySession.get(row.session_id)
    if (!activity) utcBySession.set(row.session_id, (activity = []))
    activity.push([row.utc_minute, row.event_count, row.user_event_count])
  }
  const output = new Map<number, LocalActivityTuple[]>()
  for (const [sessionId, activity] of utcBySession) {
    output.set(sessionId, localActivityOf(activity, timezone))
  }
  return output
}

function attentionByCapture(db: TrailsDb, timezone: string): Map<number, CaptureAttentionTupleV1[]> {
  const rows = db.sqlite
    .query("SELECT capture_id, utc_minute FROM capture_attention ORDER BY capture_id, utc_minute")
    .all() as Array<{ capture_id: number; utc_minute: number }>
  const utcByCapture = new Map<number, UtcActivityTuple[]>()
  for (const row of rows) {
    let attention = utcByCapture.get(row.capture_id)
    if (!attention) utcByCapture.set(row.capture_id, (attention = []))
    attention.push([row.utc_minute, 1, 1])
  }
  const output = new Map<number, CaptureAttentionTupleV1[]>()
  for (const [captureId, attention] of utcByCapture) {
    output.set(
      captureId,
      localActivityOf(attention, timezone).map(([date, minute]) => [date, minute]),
    )
  }
  return output
}

type CaptureImageMetadata = {
  readonly index: number
  readonly mime: "image/jpeg" | "image/png" | "image/webp"
  readonly width: number
  readonly height: number
  readonly byteLength: number
  readonly hash: string
}

function imagesByCapture(db: TrailsDb): Map<number, CaptureImageMetadata[]> {
  const rows = db.sqlite
    .query(
      `SELECT capture_id, image_index, mime, width, height, length(bytes) AS byte_length, content_hash
       FROM capture_images ORDER BY capture_id, image_index`,
    )
    .all() as Array<{
    capture_id: number
    image_index: number
    mime: CaptureImageMetadata["mime"]
    width: number
    height: number
    byte_length: number
    content_hash: string
  }>
  const output = new Map<number, CaptureImageMetadata[]>()
  for (const row of rows) {
    let images = output.get(row.capture_id)
    if (!images) output.set(row.capture_id, (images = []))
    images.push({
      index: row.image_index,
      mime: row.mime,
      width: row.width,
      height: row.height,
      byteLength: row.byte_length,
      hash: row.content_hash,
    })
  }
  return output
}

export function bootstrapOf(db: TrailsDb, now = Date.now()): BootstrapV1 {
  const timezone = (
    db.sqlite.query("SELECT timezone FROM settings WHERE id = 1").get() as { timezone: string }
  ).timezone
  const activity = activitiesBySession(db, timezone)
  const captureAttention = attentionByCapture(db, timezone)
  const captureImages = imagesByCapture(db)
  const sessionRows = db.sqlite
    .query(
      `SELECT s.id, m.id AS machine_id, m.name AS machine_name, s.source, s.cwd, s.branch,
         s.started_at, s.ended_at, s.event_count, s.user_event_count, s.first_prompt
       FROM sessions s JOIN machines m ON m.id = s.machine_id ORDER BY s.started_at, s.id`,
    )
    .all() as Array<{
    id: number
    machine_id: string
    machine_name: string
    source: BootstrapSessionV1["source"]
    cwd: string | null
    branch: string | null
    started_at: string
    ended_at: string
    event_count: number
    user_event_count: number
    first_prompt: string | null
  }>
  const captureRows = db.sqlite
    .query(
      `SELECT id, source, source_record_id, project, project_hint, title, started_at, ended_at,
         summary_input, provider_payload, updated_at FROM captures ORDER BY started_at, id`,
    )
    .all() as Array<{
    id: number
    source: BootstrapCaptureV1["source"]
    source_record_id: string
    project: string | null
    project_hint: string | null
    title: string
    started_at: string
    ended_at: string | null
    summary_input: string
    provider_payload: string
    updated_at: number
  }>
  const captureIdBySourceRecord = new Map(captureRows.map((row) => [row.source_record_id, row.id]))
  const settings = db.sqlite
    .query("SELECT boundary, halo, onboarding_version, hub_url, timezone FROM settings WHERE id = 1")
    .get() as {
    boundary: 4 | 5 | 6 | 7
    halo: 0 | 5 | 10 | 15
    onboarding_version: number
    hub_url: string
    timezone: string
  }
  const indexed = db.sqlite
    .query(
      `SELECT MAX(updated_at) AS at FROM (
         SELECT updated_at FROM sessions
         UNION ALL
         SELECT updated_at FROM captures
       )`,
    )
    .get() as { at: number | null }
  const assignments: Record<string, string> = {}
  const names: Record<string, string> = {}
  const preferences = db.sqlite
    .query("SELECT project, engagement_id, display_name FROM project_preferences ORDER BY project")
    .all() as Array<{ project: string; engagement_id: string | null; display_name: string | null }>
  for (const preference of preferences) {
    if (preference.engagement_id !== null) assignments[preference.project] = preference.engagement_id
    if (preference.display_name !== null) names[preference.project] = preference.display_name
  }
  const sessionSummaries: Record<string, string> = {}
  for (const row of db.sqlite.query("SELECT session_id, summary FROM session_summaries ORDER BY session_id").all() as Array<{
    session_id: number
    summary: string
  }>) {
    sessionSummaries[String(row.session_id)] = row.summary
  }
  const daySummaries: Record<string, string> = {}
  for (const row of db.sqlite
    .query("SELECT work_date, project, summary FROM day_summaries WHERE boundary = ? ORDER BY work_date, project")
    .all(settings.boundary) as Array<{ work_date: string; project: string; summary: string }>) {
    daySummaries[`${row.work_date}|${row.project}`] = row.summary
  }
  const bootstrap: BootstrapV1 = {
    protocolVersion: 1,
    revision: revisionOf(db),
    generatedAt: new Date(now).toISOString(),
    indexedAt: indexed.at === null ? null : new Date(indexed.at).toISOString(),
    hubUrl: settings.hub_url,
    timezone: settings.timezone,
    sessions: sessionRows.map((row) => ({
      id: String(row.id),
      machine: { id: row.machine_id, name: row.machine_name },
      source: row.source,
      cwd: row.cwd,
      branch: row.branch,
      start: row.started_at,
      end: row.ended_at,
      events: row.event_count,
      userEvents: row.user_event_count,
      firstPrompt: row.first_prompt,
      activity: activity.get(row.id) ?? [],
    })),
    captures: captureRows.map((row): BootstrapCaptureV1 => {
      const payload = JSON.parse(row.provider_payload) as Record<string, unknown>
      const common = {
        id: String(row.id),
        project: row.project,
        projectHint: row.project_hint,
        title: row.title,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        summaryInput: row.summary_input,
        attentionMinutes: captureAttention.get(row.id) ?? [],
        updatedAt: new Date(row.updated_at).toISOString(),
        images: (captureImages.get(row.id) ?? []).map((image) => ({
          index: image.index,
          mime: image.mime,
          width: image.width,
          height: image.height,
          byteLength: image.byteLength,
          // Bypass images cached under the former one-year immutable policy.
          url: `/api/capture-images/${row.id}/${image.index}?v=2-${image.hash}`,
        })),
      }
      if (row.source === "midjourney") {
        const parentSourceRecordId =
          typeof payload.parentSourceRecordId === "string" ? payload.parentSourceRecordId : null
        return {
          ...common,
          source: "midjourney",
          payload: {
            eventType: payload.eventType as string,
            jobType: payload.jobType as string,
            parentGrid: payload.parentGrid as number | null,
            hasParent: parentSourceRecordId !== null,
            parentCaptureId:
              parentSourceRecordId === null
                ? null
                : String(captureIdBySourceRecord.get(parentSourceRecordId) ?? "") || null,
          },
        }
      }
      return {
        ...common,
        source: "granola",
        payload: {
          attendeeCount: payload.attendeeCount as number,
          folders: payload.folders as string[],
          webUrl: payload.webUrl as string | null,
        },
      }
    }),
    summaries: { sessions: sessionSummaries, days: daySummaries },
    preferences: {
      boundary: settings.boundary,
      halo: settings.halo,
      onboardingVersion: settings.onboarding_version,
      assignments,
      customEngagements: (db.sqlite
        .query("SELECT id, name FROM custom_engagements ORDER BY created_at, id")
        .all() as Array<{ id: string; name: string }>),
      names,
      pocket: (db.sqlite
        .query("SELECT id, text, created_at AS at FROM pocket_items ORDER BY created_at DESC, id DESC")
        .all() as Array<{ id: string; text: string; at: number }>),
    },
  }
  return decodeExact(BootstrapV1Schema, encodeExact(BootstrapV1Schema, bootstrap))
}



function machinesOf(db: TrailsDb, now: number): MachinesV1 {
  const rows = db.sqlite
    .query(
      `SELECT id, name, first_seen_at, last_ingested_at, last_checked_at, last_processed_at,
         last_error, last_discovered, last_changed, last_uploaded, last_ignored, last_unchanged
       FROM machines ORDER BY name COLLATE NOCASE, id`,
    )
    .all() as Array<{
    id: string
    name: string
    first_seen_at: number
    last_ingested_at: number | null
    last_checked_at: number | null
    last_processed_at: number | null
    last_error: MachinesV1["machines"][number]["lastError"]
    last_discovered: number | null
    last_changed: number | null
    last_uploaded: number | null
    last_ignored: number | null
    last_unchanged: number | null
  }>
  return decodeExact(MachinesV1Schema, {
    protocolVersion: 1,
    generatedAt: new Date(now).toISOString(),
    machines: rows.map((row) => ({
      id: row.id,
      name: row.name,
      firstSeenAt: new Date(row.first_seen_at).toISOString(),
      lastIngestedAt:
        row.last_ingested_at === null ? null : new Date(row.last_ingested_at).toISOString(),
      lastCheckedAt:
        row.last_checked_at === null ? null : new Date(row.last_checked_at).toISOString(),
      lastProcessedAt:
        row.last_processed_at === null ? null : new Date(row.last_processed_at).toISOString(),
      lastError: row.last_error,
      metrics:
        row.last_discovered === null
          ? null
          : {
              discovered: row.last_discovered,
              changed: row.last_changed!,
              uploaded: row.last_uploaded!,
              ignored: row.last_ignored!,
              unchanged: row.last_unchanged!,
            },
    })),
  })
}

function recordCollectorStatus(
  db: TrailsDb,
  input: Schema.Schema.Type<typeof CollectorStatusV1Schema>,
  now: number,
): void {
  db.sqlite.transaction(() => {
    const existing = db.sqlite
      .query(
        `SELECT m.name, EXISTS(SELECT 1 FROM sessions s WHERE s.machine_id = m.id) AS owns_sessions
         FROM machines m WHERE m.id = ?`,
      )
      .get(input.device.id) as { name: string; owns_sessions: number } | null
    if (!existing) {
      db.sqlite
        .query(
          `INSERT INTO machines(id, name, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(input.device.id, input.device.name, now, now)
    } else {
      db.sqlite
        .query("UPDATE machines SET name = ?, last_seen_at = ? WHERE id = ?")
        .run(input.device.name, now, input.device.id)
      if (existing.name !== input.device.name && existing.owns_sessions === 1) incrementRevision(db)
    }

    if (input.outcome.status === "processed") {
      const metrics = input.outcome.metrics
      db.sqlite
        .query(
          `UPDATE machines SET last_checked_at = ?, last_processed_at = ?, last_error = NULL,
             last_discovered = ?, last_changed = ?, last_uploaded = ?, last_ignored = ?, last_unchanged = ?
           WHERE id = ?`,
        )
        .run(
          now,
          now,
          metrics.discovered,
          metrics.changed,
          metrics.uploaded,
          metrics.ignored,
          metrics.unchanged,
          input.device.id,
        )
    } else {
      const metrics = input.outcome.metrics
      db.sqlite
        .query(
          `UPDATE machines SET last_checked_at = ?, last_error = ?,
             last_discovered = ?, last_changed = ?, last_uploaded = ?, last_ignored = ?, last_unchanged = ?
           WHERE id = ?`,
        )
        .run(
          now,
          input.outcome.error,
          metrics?.discovered ?? null,
          metrics?.changed ?? null,
          metrics?.uploaded ?? null,
          metrics?.ignored ?? null,
          metrics?.unchanged ?? null,
          input.device.id,
        )
    }
  })()
}

function summarizationOf(options: AppOptions): unknown {
  const active = options.summarization?.describe() ?? null
  if (active?.harness === null || !active) {
    return decodeExact(SummarizationStatusV2Schema, { enabled: false, metadata: null })
  }
  return decodeExact(SummarizationStatusV2Schema, {
    enabled: true,
    metadata: {
      protocolVersion: 2,
      harness: active.harness,
      prompts: { session: SESSION_SYSTEM, day: DAY_SYSTEM },
    },
  })
}

async function apiResponse(options: AppOptions, request: Request, url: URL, now: number, credential: Credential): Promise<Response> {
  const { db } = options
  if (url.pathname === "/api/bootstrap") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const afterValue = url.searchParams.get("after")
    if (afterValue !== null && (!/^\d+$/.test(afterValue) || !Number.isSafeInteger(Number(afterValue)))) {
      throw new ApiError("invalid_request", "after must be a nonnegative integer", 400)
    }
    if (afterValue !== null && Number(afterValue) === revisionOf(db)) return new Response(null, { status: 204 })
    return jsonResponse(bootstrapOf(db, now))
  }
  if (url.pathname === "/api/captures") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const input = await readJson(request, 5 * 1024 * 1024)
    if (
      typeof input === "object" &&
      input !== null &&
      "protocolVersion" in input &&
      input.protocolVersion !== 1
    ) {
      throw new ApiError("unsupported_protocol", "unsupported protocol version", 400)
    }
    const body = decodeBody(IngestCapturesRequestV1Schema, input)
    requireDevice(credential, body.device.id)
    try {
      return jsonResponse(await Effect.runPromise(ingestCaptures(db, body, now)))
    } catch {
      throw new ApiError("internal_error", "internal server error", 500)
    }
  }
  if (url.pathname.startsWith("/api/capture-images/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ApiError("method_not_allowed", "method not allowed", 405)
    }
    const match = /^\/api\/capture-images\/([1-9]\d*)\/([0-3])$/.exec(url.pathname)
    if (!match || !Number.isSafeInteger(Number(match[1]))) {
      throw new ApiError("invalid_request", "invalid capture image path", 400)
    }
    const row = db.sqlite
      .query(
        `SELECT mime, bytes, content_hash, length(bytes) AS byte_length
         FROM capture_images WHERE capture_id = ? AND image_index = ?`,
      )
      .get(Number(match[1]), Number(match[2])) as
      | { mime: string; bytes: Uint8Array; content_hash: string; byte_length: number }
      | null
    if (!row) throw new ApiError("not_found", "capture image not found", 404)
    const etag = `"${row.content_hash}"`
    const headers = new Headers({
      "Content-Type": row.mime,
      "Content-Length": String(row.byte_length),
      "Cache-Control": privateCacheControl,
      ETag: etag,
    })
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers })
    return new Response(request.method === "HEAD" ? null : Buffer.from(row.bytes), { status: 200, headers })
  }
  if (url.pathname === "/api/ingest") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const input = await readJson(request, 5 * 1024 * 1024)
    if (
      typeof input === "object" &&
      input !== null &&
      "protocolVersion" in input &&
      input.protocolVersion !== 2
    ) {
      throw new ApiError("unsupported_protocol", "unsupported protocol version", 400)
    }
    const body = decodeBody(IngestRequestV2Schema, input)
    requireDevice(credential, body.device.id)
    try {
      return jsonResponse(await Effect.runPromise(ingestSessions(db, body, now)))
    } catch {
      throw new ApiError("internal_error", "internal server error", 500)
    }
  }
  if (url.pathname === "/api/collector-status") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const input = await readJson(request, 64 * 1024)
    if (
      typeof input === "object" &&
      input !== null &&
      "protocolVersion" in input &&
      input.protocolVersion !== 1
    ) {
      throw new ApiError("unsupported_protocol", "unsupported protocol version", 400)
    }
    const body = decodeBody(CollectorStatusV1Schema, input)
    requireDevice(credential, body.device.id)
    recordCollectorStatus(db, body, now)
    return new Response(null, { status: 204 })
  }
  if (url.pathname === "/api/machines") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    return jsonResponse(machinesOf(db, now))
  }
  if (url.pathname === "/api/harnesses") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    if (!options.harnesses) throw new ApiError("not_found", "harness API is unavailable", 404)
    return jsonResponse(options.harnesses.status())
  }
  if (url.pathname === "/api/summarizer") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    if (!options.harnesses) throw new ApiError("not_found", "harness API is unavailable", 404)
    const body = decodeBody(SummarizerSelectionBodySchema, await readJson(request, 64 * 1024))
    try {
      if (body === null) options.harnesses.disconnect()
      else options.harnesses.activate(body)
    } catch {
      throw new ApiError("invalid_request", "selected harness is unavailable", 400)
    }
    return jsonResponse({ ok: true })
  }
  if (url.pathname === "/api/summarization") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    return jsonResponse(summarizationOf(options))
  }
  if (url.pathname === "/api/settings") {
    if (request.method !== "PATCH") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(SettingsPatchSchema, await readJson(request, 64 * 1024))
    const current = db.sqlite
      .query("SELECT boundary, halo, onboarding_version, timezone FROM settings WHERE id = 1")
      .get() as {
      boundary: number
      halo: number
      onboarding_version: number
      timezone: string
    }
    const boundary = body.boundary ?? current.boundary
    const halo = body.halo ?? current.halo
    const onboardingVersion = body.onboardingVersion ?? current.onboarding_version
    const timezone = body.timezone ?? current.timezone
    if (
      boundary === current.boundary &&
      halo === current.halo &&
      onboardingVersion === current.onboarding_version &&
      timezone === current.timezone
    ) {
      return jsonResponse({ revision: revisionOf(db) })
    }
    const revision = db.sqlite.transaction(() => {
      db.sqlite
        .query("UPDATE settings SET boundary = ?, halo = ?, onboarding_version = ?, timezone = ? WHERE id = 1")
        .run(boundary, halo, onboardingVersion, timezone)
      if (timezone !== current.timezone || boundary !== current.boundary) {
        rebuildDaySummaryJobs(db.sqlite, {
          boundary,
          timezone,
          now,
          clearSummaries: timezone !== current.timezone,
        })
      }
      return incrementRevision(db)
    })()
    return jsonResponse({ revision })
  }
  if (url.pathname === "/api/projects") {
    if (request.method !== "PUT") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(ProjectPatchSchema, await readJson(request, 64 * 1024))
    const project = body.project.trim()
    const present = db.sqlite
      .query(
        `SELECT 1 AS present FROM sessions WHERE project = ?
         UNION ALL SELECT 1 AS present FROM captures WHERE project = ? LIMIT 1`,
      )
      .get(project, project)
    if (!present) throw new ApiError("not_found", "project not found", 404)
    const existing = db.sqlite
      .query("SELECT engagement_id, display_name FROM project_preferences WHERE project = ?")
      .get(project) as { engagement_id: string | null; display_name: string | null } | null
    let engagementId = existing?.engagement_id ?? null
    let displayName = existing?.display_name ?? null
    if ("engagementId" in body) engagementId = body.engagementId ?? null
    if ("displayName" in body) displayName = body.displayName?.trim() || null
    if (engagementId !== null) {
      const validOrgIds = new Set(
        (
          db.sqlite
            .query(
              `SELECT project FROM sessions
               UNION SELECT project FROM captures WHERE project IS NOT NULL`,
            )
            .all() as Array<{ project: string }>
        ).map((row) => `org:${orgOf(row.project)}`),
      )
      const validCustom = engagementId.startsWith("custom:")
        ? db.sqlite.query("SELECT 1 AS present FROM custom_engagements WHERE id = ?").get(engagementId)
        : null
      if (engagementId !== "elsewhere" && !validOrgIds.has(engagementId) && !validCustom) {
        throw new ApiError("not_found", "engagement not found", 404)
      }
    }
    if (engagementId === (existing?.engagement_id ?? null) && displayName === (existing?.display_name ?? null)) {
      return jsonResponse({ revision: revisionOf(db) })
    }
    const revision = db.sqlite.transaction(() => {
      if (engagementId === null && displayName === null) {
        db.sqlite.query("DELETE FROM project_preferences WHERE project = ?").run(project)
      } else {
        db.sqlite
          .query(
            `INSERT INTO project_preferences(project, engagement_id, display_name) VALUES (?, ?, ?)
             ON CONFLICT(project) DO UPDATE SET engagement_id = excluded.engagement_id, display_name = excluded.display_name`,
          )
          .run(project, engagementId, displayName)
      }
      return incrementRevision(db)
    })()
    return jsonResponse({ revision })
  }
  if (url.pathname === "/api/engagements") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(EngagementCreateSchema, await readJson(request, 64 * 1024))
    const existing = db.sqlite
      .query("SELECT id, name FROM custom_engagements WHERE name = ? COLLATE NOCASE")
      .get(body.name) as { id: string; name: string } | null
    if (existing) return jsonResponse({ revision: revisionOf(db), engagement: existing })
    const engagement = { id: `custom:${crypto.randomUUID()}`, name: body.name }
    const revision = db.sqlite.transaction(() => {
      db.sqlite
        .query("INSERT INTO custom_engagements(id, name, created_at) VALUES (?, ?, ?)")
        .run(engagement.id, engagement.name, now)
      return incrementRevision(db)
    })()
    return jsonResponse({ revision, engagement })
  }
  if (url.pathname === "/api/pocket") {
    if (request.method !== "POST") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(PocketCreateSchema, await readJson(request, 64 * 1024))
    const item = { id: crypto.randomUUID(), text: body.text, at: now }
    const revision = db.sqlite.transaction(() => {
      db.sqlite.query("INSERT INTO pocket_items(id, text, created_at) VALUES (?, ?, ?)").run(item.id, item.text, item.at)
      return incrementRevision(db)
    })()
    return jsonResponse({ revision, item }, 201)
  }
  if (url.pathname.startsWith("/api/pocket/")) {
    if (request.method !== "DELETE") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const id = decodeURIComponent(url.pathname.slice("/api/pocket/".length))
    const removed = db.sqlite.query("DELETE FROM pocket_items WHERE id = ? RETURNING id").get(id)
    if (!removed) throw new ApiError("not_found", "pocket item not found", 404)
    return jsonResponse({ revision: incrementRevision(db) })
  }
  throw new ApiError("not_found", "API route not found", 404)
}

async function staticResponse(options: AppOptions, request: Request, url: URL): Promise<Response> {
  if (!options.staticRoot) throw new ApiError("not_found", "static serving is disabled", 404)
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new ApiError("method_not_allowed", "method not allowed", 405)
  }
  let decoded: string
  try {
    const rawPath = request.url.slice(url.origin.length).split(/[?#]/, 1)[0] || "/"
    decoded = decodeURIComponent(rawPath)
  } catch {
    throw new ApiError("invalid_request", "invalid path encoding", 400)
  }
  if (decoded.includes("\0") || decoded.split("/").includes("..")) {
    throw new ApiError("invalid_request", "invalid path", 400)
  }
  const root = resolve(options.staticRoot)
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "")
  const candidate = resolve(root, requested)
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new ApiError("invalid_request", "invalid path", 400)
  }
  let body: Blob
  let selectedName = requested
  const diskFile = Bun.file(candidate)
  if (await diskFile.exists()) {
    body = diskFile
  } else {
    const embedded = options.staticAssets?.find((asset) => basename(asset.name) === basename(requested))
      ?? options.staticAssets?.find((asset) => basename(asset.name) === "index.html")
    if (embedded) {
      body = embedded
      selectedName = basename(embedded.name)
    } else {
      const index = Bun.file(join(root, "index.html"))
      if (!(await index.exists())) throw new ApiError("not_found", "static file not found", 404)
      body = index
      selectedName = "index.html"
    }
  }
  const isIndex = basename(selectedName) === "index.html"
  const cacheControl = isIndex ? "no-store" : /-[A-Za-z0-9_-]{8,}\./.test(basename(selectedName))
    ? "public, max-age=31536000, immutable"
    : "no-cache"
  const headers = new Headers({ "Cache-Control": cacheControl, "Content-Type": body.type || "application/octet-stream" })
  if (request.method === "HEAD") {
    headers.set("Content-Length", String(body.size))
    return new Response(null, { status: 200, headers })
  }
  return new Response(body, { headers })
}

function requireDevice(credential: Credential, deviceId: string): void {
  if (credential.role !== "collector" || credential.deviceId !== deviceId) {
    throw new ApiError("forbidden", "credential is not paired to this device", 403)
  }
}

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  const origins = options.trustedOrigins ?? localOrigins(7412)
  const requestBoundary = createRequestBoundary(origins)
  const secureAuthorities = new Set(origins.flatMap(origin => {
    const url = new URL(origin)
    return url.protocol === "https:" ? [url.host, `${url.hostname}:${url.port || "443"}`] : []
  }))
  const auth = createAuthentication(options.db, secureAuthorities)
  return async (request) => {
    try {
      const url = new URL(request.url)
      const rejection = requestBoundary(request, url)
      if (rejection) throw new ApiError(rejection, "request origin or host is not trusted", 403)
      const now = (options.now ?? Date.now)()
      if (!url.pathname.startsWith("/api/")) return await staticResponse(options, request, url)
      if (url.pathname === "/api/health") {
        if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
        return jsonResponse({ ok: true })
      }
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = decodeBody(Schema.Struct({ token: Schema.String }), await readJson(request, 1024))
        const credential = credentialFor(options.db, body.token)
        if (!credential || credential.role !== "owner") throw new ApiError("unauthorized", "owner credential required", 401)
        return new Response(null, { status: 204, headers: { "Set-Cookie": auth.login(credential, url, now), "Cache-Control": privateCacheControl } })
      }
      const credential = auth.authenticate(request, url, now)
      if (!credential) throw new ApiError("unauthorized", "sign in to Trails", 401)
      if (url.pathname === "/api/auth/session" && request.method === "GET") return jsonResponse({ role: credential.role })
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        return new Response(null, { status: 204, headers: { "Set-Cookie": auth.logout(request, url), "Cache-Control": privateCacheControl } })
      }
      const ingest = ["/api/ingest", "/api/captures", "/api/collector-status"].includes(url.pathname)
      const permitted = ingest ? credential.role === "collector"
        : ["GET", "HEAD"].includes(request.method) ? credential.role !== "collector" : credential.role === "owner"
      if (!permitted) throw new ApiError("forbidden", "credential does not grant this permission", 403)
      const response = await apiResponse(options, request, url, now, credential)
      response.headers.set("Cache-Control", privateCacheControl)
      return response
    } catch (error) {
      return errorResponse(error instanceof ApiError ? error : new ApiError("internal_error", "internal server error", 500))
    }
  }
}
