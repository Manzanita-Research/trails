import { Effect, Schema } from "effect"
import { basename, join, resolve, sep } from "node:path"
import { orgOf, TIMEZONE, workdaysOf, type ActivityTuple } from "../shared/domain"
import {
  BootstrapV1Schema,
  EngagementCreateSchema,
  IngestRequestV1Schema,
  PocketCreateSchema,
  ProjectPatchSchema,
  SettingsPatchSchema,
  decodeExact,
  encodeExact,
  type BootstrapV1,
  type BootstrapSessionV1,
} from "../shared/protocol"
import type { TrailsDb } from "./db"
import { ingestSessions } from "./ingest"

export interface InferenceConfig {
  readonly url: string
  readonly token: string
}

export interface AppOptions {
  readonly db: TrailsDb
  readonly staticRoot?: string
  readonly staticAssets?: ReadonlyArray<Blob & { readonly name: string }>
  readonly inference?: InferenceConfig
  readonly now?: () => number
}

type ErrorCode =
  | "invalid_json"
  | "invalid_request"
  | "unsupported_protocol"
  | "payload_too_large"
  | "not_found"
  | "method_not_allowed"
  | "internal_error"

class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" }

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

function activitiesBySession(db: TrailsDb): Map<number, ActivityTuple[]> {
  const rows = db.sqlite
    .query(
      "SELECT session_id, local_date, minute, event_count, user_event_count FROM session_activity ORDER BY session_id, local_date, minute",
    )
    .all() as Array<{
    session_id: number
    local_date: string
    minute: number
    event_count: number
    user_event_count: number
  }>
  const output = new Map<number, ActivityTuple[]>()
  for (const row of rows) {
    let activity = output.get(row.session_id)
    if (!activity) output.set(row.session_id, (activity = []))
    activity.push([row.local_date, row.minute, row.event_count, row.user_event_count])
  }
  return output
}

export function bootstrapOf(db: TrailsDb, now = Date.now()): BootstrapV1 {
  const activity = activitiesBySession(db)
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
  const settings = db.sqlite
    .query("SELECT boundary, halo, onboarding_version FROM settings WHERE id = 1")
    .get() as {
    boundary: 4 | 5 | 6 | 7
    halo: 0 | 5 | 10 | 15
    onboarding_version: number
  }
  const indexed = db.sqlite.query("SELECT MAX(updated_at) AS at FROM sessions").get() as { at: number | null }
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
    timezone: TIMEZONE,
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

function enqueueBoundaryDays(db: TrailsDb, boundary: number, now: number): void {
  const activity = activitiesBySession(db)
  const rows = db.sqlite.query("SELECT id, project FROM sessions").all() as Array<{ id: number; project: string }>
  const keys = new Set<string>()
  for (const row of rows) {
    for (const day of workdaysOf(activity.get(row.id) ?? [], boundary)) keys.add(`${day}|${row.project}`)
  }
  const statement = db.sqlite.query(
    `INSERT INTO day_summary_jobs(work_date, project, boundary, generation, attempts, available_at, last_error)
     VALUES (?, ?, ?, 1, 0, ?, NULL)
     ON CONFLICT(work_date, project, boundary) DO UPDATE SET generation = day_summary_jobs.generation + 1,
       attempts = 0, available_at = excluded.available_at, last_error = NULL`,
  )
  for (const key of keys) {
    const separator = key.indexOf("|")
    statement.run(key.slice(0, separator), key.slice(separator + 1), boundary, now)
  }
}

async function apiResponse(options: AppOptions, request: Request, url: URL, now: number): Promise<Response> {
  const { db } = options
  if (url.pathname === "/api/health") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    return jsonResponse({ ok: true, revision: revisionOf(db) })
  }
  if (url.pathname === "/api/bootstrap") {
    if (request.method !== "GET") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const afterValue = url.searchParams.get("after")
    if (afterValue !== null && (!/^\d+$/.test(afterValue) || !Number.isSafeInteger(Number(afterValue)))) {
      throw new ApiError("invalid_request", "after must be a nonnegative integer", 400)
    }
    if (afterValue !== null && Number(afterValue) === revisionOf(db)) return new Response(null, { status: 204 })
    return jsonResponse(bootstrapOf(db, now))
  }
  if (url.pathname === "/api/ingest") {
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
    const body = decodeBody(IngestRequestV1Schema, input)
    try {
      return jsonResponse(await Effect.runPromise(ingestSessions(db, body, now)))
    } catch {
      throw new ApiError("internal_error", "internal server error", 500)
    }
  }
  if (url.pathname === "/api/settings") {
    if (request.method !== "PATCH") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(SettingsPatchSchema, await readJson(request, 64 * 1024))
    const current = db.sqlite
      .query("SELECT boundary, halo, onboarding_version FROM settings WHERE id = 1")
      .get() as {
      boundary: number
      halo: number
      onboarding_version: number
    }
    const boundary = body.boundary ?? current.boundary
    const halo = body.halo ?? current.halo
    const onboardingVersion = body.onboardingVersion ?? current.onboarding_version
    if (
      boundary === current.boundary &&
      halo === current.halo &&
      onboardingVersion === current.onboarding_version
    ) {
      return jsonResponse({ revision: revisionOf(db) })
    }
    const revision = db.sqlite.transaction(() => {
      db.sqlite
        .query("UPDATE settings SET boundary = ?, halo = ?, onboarding_version = ? WHERE id = 1")
        .run(boundary, halo, onboardingVersion)
      if (boundary !== current.boundary) {
        db.sqlite.query("DELETE FROM day_summary_jobs WHERE boundary <> ?").run(boundary)
        enqueueBoundaryDays(db, boundary, now)
      }
      return incrementRevision(db)
    })()
    return jsonResponse({ revision })
  }
  if (url.pathname === "/api/projects") {
    if (request.method !== "PUT") throw new ApiError("method_not_allowed", "method not allowed", 405)
    const body = decodeBody(ProjectPatchSchema, await readJson(request, 64 * 1024))
    const project = body.project.trim()
    const present = db.sqlite.query("SELECT 1 AS present FROM sessions WHERE project = ? LIMIT 1").get(project)
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
        (db.sqlite.query("SELECT DISTINCT project FROM sessions").all() as Array<{ project: string }>).map(
          (row) => `org:${orgOf(row.project)}`,
        ),
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

export function createApp(options: AppOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url)
      const now = (options.now ?? Date.now)()
      return url.pathname.startsWith("/api/")
        ? await apiResponse(options, request, url, now)
        : await staticResponse(options, request, url)
    } catch (error) {
      return errorResponse(error instanceof ApiError ? error : new ApiError("internal_error", "internal server error", 500))
    }
  }
}
