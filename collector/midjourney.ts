import { Schema } from "effect"
import { decodeExact, type IngestCaptureV1, type MidjourneyCaptureV1 } from "../shared/protocol"
import type { CaptureAdapter, CaptureFetcher } from "./captures"

const MIDJOURNEY_PAGE = "https://www.midjourney.com/imagine"
const MIDJOURNEY_CDN = "cdn.midjourney.com"
const MAX_IMAGE_BYTES = 500 * 1024
const RESULT_MARKER = "TRAILS_MIDJOURNEY_RESULT:"

export interface MidjourneyCursor {
  readonly enqueueTime: string
  readonly id: string
}

export interface MidjourneyBrowserCapture {
  readonly authenticated: boolean
  readonly imagineBodies: ReadonlyArray<unknown>
  readonly folderBodies: ReadonlyArray<unknown>
  readonly saturated: boolean
}

export interface MidjourneyBrowserBridge {
  capture(): Promise<MidjourneyBrowserCapture>
}

export interface MidjourneyJob {
  readonly id: string
  readonly enqueueTime: string
  readonly eventType: string
  readonly jobType: string
  readonly parentId: string | null
  readonly parentGrid: number | null
  readonly width: number
  readonly height: number
  readonly fullCommand: string
}

export interface MidjourneyFeed {
  readonly jobs: ReadonlyArray<MidjourneyJob>
  readonly folderByJob: ReadonlyMap<string, string>
  readonly saturated: boolean
}

export interface MidjourneyAdapterOptions {
  readonly jobs?: ReadonlyArray<string>
  readonly project?: string | null
  readonly since?: string
  readonly limit?: number
  readonly browser?: MidjourneyBrowserBridge
  readonly fetch?: CaptureFetcher
}

const RawJobSchema = Schema.Struct({
  id: Schema.String,
  enqueue_time: Schema.String,
  event_type: Schema.String,
  job_type: Schema.String,
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
  parent_grid: Schema.optional(Schema.NullOr(Schema.Number)),
  width: Schema.Number,
  height: Schema.Number,
  full_command: Schema.String,
})

const RawFolderSchema = Schema.Struct({
  title: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  images: Schema.Array(Schema.Struct({ id: Schema.String })),
})

const CursorSchema = Schema.Struct({
  enqueueTime: Schema.String,
  id: Schema.String,
})

const BrowserCaptureSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  imagineBodies: Schema.Array(Schema.Unknown),
  folderBodies: Schema.Array(Schema.Unknown),
  saturated: Schema.Boolean,
})

function canonicalTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Midjourney ${field} is missing`)
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new Error(`Midjourney ${field} is invalid`)
  return parsed.toISOString()
}

function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`Midjourney ${field} is missing`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maximum) throw new Error(`Midjourney ${field} is outside its supported bounds`)
  return trimmed
}

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === null || value === undefined) return null
  return boundedText(value, field, maximum)
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`Midjourney ${field} is invalid`)
  }
  return value as number
}

function jobsOfBody(body: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(body)) return body
  if (typeof body !== "object" || body === null) throw new Error("Midjourney imagine response shape changed")
  if ("jobs" in body && Array.isArray(body.jobs)) return body.jobs
  if ("data" in body && Array.isArray(body.data)) return body.data
  throw new Error("Midjourney imagine response shape changed")
}

function foldersOfBody(body: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(body)) return body
  if (typeof body === "object" && body !== null && "folders" in body && Array.isArray(body.folders)) {
    return body.folders
  }
  throw new Error("Midjourney folders response shape changed")
}

function normalizeJob(input: unknown): MidjourneyJob {
  let raw: Schema.Schema.Type<typeof RawJobSchema>
  try {
    raw = Schema.decodeUnknownSync(RawJobSchema)(input)
  } catch {
    throw new Error("Midjourney job response shape changed")
  }
  const id = boundedText(raw.id, "job id", 128)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Midjourney job id contains unsupported characters")
  const fullCommand = boundedText(raw.full_command, "full command", 12_000)
  const parentGrid =
    raw.parent_grid === null || raw.parent_grid === undefined
      ? null
      : boundedInteger(raw.parent_grid, "parent grid", 0, 3)
  return {
    id,
    enqueueTime: canonicalTimestamp(raw.enqueue_time, "enqueue time"),
    eventType: boundedText(raw.event_type, "event type", 100),
    jobType: boundedText(raw.job_type, "job type", 100),
    parentId: nullableText(raw.parent_id, "parent id", 128),
    parentGrid,
    width: boundedInteger(raw.width, "width", 1, 16_384),
    height: boundedInteger(raw.height, "height", 1, 16_384),
    fullCommand,
  }
}

function addFolders(body: unknown, output: Map<string, string>): void {
  for (const input of foldersOfBody(body)) {
    let folder: Schema.Schema.Type<typeof RawFolderSchema>
    try {
      folder = Schema.decodeUnknownSync(RawFolderSchema)(input)
    } catch {
      throw new Error("Midjourney folder response shape changed")
    }
    const title = boundedText(folder.title ?? folder.name, "folder title", 200)
    for (const image of folder.images) {
      if (!output.has(image.id)) output.set(image.id, title)
    }
  }
}

export function reduceMidjourneyBrowserCapture(capture: MidjourneyBrowserCapture): MidjourneyFeed {
  if (!capture.authenticated) throw new Error("Midjourney is not authenticated in the isolated browser")
  if (capture.imagineBodies.length === 0) throw new Error("Midjourney returned no successful imagine response")
  const jobs = new Map<string, MidjourneyJob>()
  for (const body of capture.imagineBodies) {
    for (const input of jobsOfBody(body)) {
      const job = normalizeJob(input)
      jobs.set(job.id, job)
    }
  }
  const folderByJob = new Map<string, string>()
  for (const body of capture.folderBodies) addFolders(body, folderByJob)
  return {
    jobs: [...jobs.values()].sort(compareJobs),
    folderByJob,
    saturated: capture.saturated,
  }
}

function comparePairs(left: MidjourneyCursor, right: MidjourneyCursor): number {
  return left.enqueueTime.localeCompare(right.enqueueTime) || left.id.localeCompare(right.id)
}

function compareJobs(left: MidjourneyJob, right: MidjourneyJob): number {
  return comparePairs(
    { enqueueTime: left.enqueueTime, id: left.id },
    { enqueueTime: right.enqueueTime, id: right.id },
  )
}

export function encodeMidjourneyCursor(cursor: MidjourneyCursor): string {
  return JSON.stringify(cursor)
}

export function decodeMidjourneyCursor(value: string): MidjourneyCursor {
  let input: Schema.Schema.Type<typeof CursorSchema>
  try {
    input = decodeExact(CursorSchema, JSON.parse(value))
  } catch {
    throw new Error("saved Midjourney cursor is invalid")
  }
  if (canonicalTimestamp(input.enqueueTime, "cursor time") !== input.enqueueTime) {
    throw new Error("saved Midjourney cursor is invalid")
  }
  return input
}

function sinceCursor(value: string): MidjourneyCursor {
  const enqueueTime = canonicalTimestamp(value, "--since")
  if (enqueueTime !== value) throw new Error("--since must be a canonical UTC timestamp with milliseconds")
  return { enqueueTime, id: "" }
}

function assetUrl(jobId: string, index: number): URL {
  const url = new URL(`https://${MIDJOURNEY_CDN}/${jobId}/${index}_640_N.webp?method=shortest`)
  if (url.protocol !== "https:" || url.hostname !== MIDJOURNEY_CDN) throw new Error("invalid Midjourney asset URL")
  return url
}

function hasWebpMagic(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
}

export async function downloadMidjourneyImages(
  job: MidjourneyJob,
  fetcher: CaptureFetcher = globalThis.fetch,
): Promise<MidjourneyCaptureV1["images"]> {
  const images: MidjourneyCaptureV1["images"][number][] = []
  for (let index = 0; index < 4; index++) {
    const requested = assetUrl(job.id, index)
    const response = await fetcher(requested, { redirect: "error" })
    const finalUrl = new URL(response.url || requested)
    if (finalUrl.protocol !== "https:" || finalUrl.hostname !== MIDJOURNEY_CDN) {
      throw new Error("Midjourney image redirected outside the approved CDN")
    }
    if (!response.ok) throw new Error(`Midjourney image ${index} returned HTTP ${response.status}`)
    const mime = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
    if (mime !== "image/webp") throw new Error(`Midjourney image ${index} is not WebP`)
    const declaredLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      throw new Error(`Midjourney image ${index} exceeds 500 KiB`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`Midjourney image ${index} exceeds 500 KiB`)
    if (!hasWebpMagic(bytes)) throw new Error(`Midjourney image ${index} has invalid WebP bytes`)
    images.push({
      index,
      mime: "image/webp",
      width: job.width,
      height: job.height,
      bytes: Buffer.from(bytes).toString("base64"),
    })
  }
  return images
}

function titleOf(command: string): string {
  const firstLine = command.split(/\r?\n/, 1)[0]!.trim()
  return firstLine.slice(0, 200).trim() || "Midjourney generation"
}

async function captureOfJob(
  job: MidjourneyJob,
  project: string | null,
  projectHint: string | null,
  fetcher: CaptureFetcher,
): Promise<MidjourneyCaptureV1> {
  const attentionMinute = Math.floor(Date.parse(job.enqueueTime) / 60_000)
  return {
    source: "midjourney",
    sourceRecordId: job.id,
    project,
    projectHint,
    title: titleOf(job.fullCommand),
    startedAt: job.enqueueTime,
    endedAt: null,
    summaryInput: job.fullCommand,
    attentionMinutes: [attentionMinute],
    payload: {
      eventType: job.eventType,
      jobType: job.jobType,
      parentSourceRecordId: job.parentId,
      parentGrid: job.parentGrid,
    },
    images: await downloadMidjourneyImages(job, fetcher),
  }
}

export async function collectMidjourneyFeed(
  browserCapture: MidjourneyBrowserCapture,
  cursor: string | null,
  options: Omit<MidjourneyAdapterOptions, "browser"> = {},
): Promise<{ readonly captures: ReadonlyArray<IngestCaptureV1>; readonly nextCursor: string | null }> {
  const feed = reduceMidjourneyBrowserCapture(browserCapture)
  const limit = options.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Midjourney limit must be between 1 and 50")
  const requestedJobs = options.jobs ?? []
  const immediate = requestedJobs.length > 0
  if (immediate && !options.project) throw new Error("--job requires --project")
  if (!immediate && cursor === null && options.since === undefined) {
    throw new Error("first Midjourney reconciliation requires --since")
  }
  const anchor = cursor !== null ? decodeMidjourneyCursor(cursor) : options.since ? sinceCursor(options.since) : null
  if (!immediate && !anchor) throw new Error("Midjourney reconciliation anchor is missing")

  let selected: MidjourneyJob[]
  if (immediate) {
    const requested = new Set(requestedJobs)
    selected = feed.jobs.filter((job) => requested.has(job.id))
    const missing = requestedJobs.filter((id) => !selected.some((job) => job.id === id))
    if (missing.length > 0) throw new Error(`requested Midjourney job did not appear: ${missing.join(", ")}`)
    selected = selected.slice(0, limit)
  } else {
    const oldest = feed.jobs[0]
    if (
      feed.saturated &&
      oldest &&
      comparePairs(anchor!, { enqueueTime: oldest.enqueueTime, id: oldest.id }) < 0
    ) {
      throw new Error("Midjourney history window is incomplete; narrow --since before advancing")
    }
    selected = feed.jobs
      .filter((job) => comparePairs({ enqueueTime: job.enqueueTime, id: job.id }, anchor!) > 0)
      .slice(0, limit)
  }

  const fetcher = options.fetch ?? globalThis.fetch
  const captures: IngestCaptureV1[] = []
  for (const job of selected) {
    captures.push(await captureOfJob(job, options.project ?? null, feed.folderByJob.get(job.id) ?? null, fetcher))
  }
  const nextCursor = immediate
    ? cursor
    : selected.length > 0
      ? encodeMidjourneyCursor({
          enqueueTime: selected[selected.length - 1]!.enqueueTime,
          id: selected[selected.length - 1]!.id,
        })
      : encodeMidjourneyCursor(anchor!)
  return { captures, nextCursor }
}

function browserScript(): string {
  return String.raw`
const task = await useOrCreateTaskSpace('trails-midjourney-capture')
let result
try {
  await openOrReuseTab('${MIDJOURNEY_PAGE}', { wait: true, timeout: 30 })
  await cdp('Network.enable')
  await cdp('Page.reload', { ignoreCache: true })
  await waitForLoad({ timeout: 30 })
  await wait(4)
  const events = await drainEvents()
  const imagineBodies = []
  const folderBodies = []
  let authenticated = true
  let saturated = false
  for (const event of events) {
    if (event?.method !== 'Network.responseReceived') continue
    const response = event.params?.response
    const url = response?.url || ''
    if (!url.includes('/api/imagine') && !url.includes('/api/folders')) continue
    if (response.status === 401 || response.status === 403) authenticated = false
    if (response.status < 200 || response.status >= 300) continue
    const body = await cdp('Network.getResponseBody', { requestId: event.params.requestId })
    if (body?.base64Encoded) continue
    const parsed = JSON.parse(body.body)
    if (url.includes('/api/imagine')) {
      imagineBodies.push(parsed)
      saturated ||= parsed?.has_more === true || parsed?.hasMore === true
    } else {
      folderBodies.push(parsed)
    }
  }
  const pageState = await js(String.raw\`(() => ({
    url: location.href,
    login: /sign in|log in/i.test(document.body?.innerText || '')
  }))()\`)
  authenticated &&= !pageState.login && !/login|signin/.test(pageState.url)
  result = { authenticated, imagineBodies, folderBodies, saturated }
  cliLog('${RESULT_MARKER}' + Buffer.from(JSON.stringify(result)).toString('base64'))
} finally {
  await completeTaskSpace(task.id, { keep: false })
}
`
}

export class EgoMidjourneyBrowserBridge implements MidjourneyBrowserBridge {
  async capture(): Promise<MidjourneyBrowserCapture> {
    const process = (() => {
      try {
        return Bun.spawn(["ego-browser", "nodejs"], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch {
        throw new Error("ego-browser is unavailable; install it before Midjourney capture")
      }
    })()
    process.stdin.write(browserScript())
    process.stdin.end()
    const outcome = await Promise.race([
      Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]).then(
        (result) => ({ tag: "done" as const, result }),
      ),
      Bun.sleep(60_000).then(() => ({ tag: "timeout" as const })),
    ])
    if (outcome.tag === "timeout") {
      process.kill()
      throw new Error("Midjourney browser capture timed out")
    }
    const [stdout, stderr, exitCode] = outcome.result
    if (exitCode !== 0) {
      const lower = stderr.toLowerCase()
      if (lower.includes("user is controlling") || lower.includes("not assigned") || lower.includes("inactive")) {
        throw new Error("Midjourney browser control is held elsewhere; retry after the task space is available")
      }
      if (lower.includes("command not found") || lower.includes("enoent")) {
        throw new Error("ego-browser is unavailable; install it before Midjourney capture")
      }
      throw new Error("Midjourney browser capture failed before a validated response was available")
    }
    const line = stdout
      .split(/\r?\n/)
      .find((candidate: string) => candidate.startsWith(RESULT_MARKER))
    if (!line) throw new Error("Midjourney browser response capture was empty")
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(line.slice(RESULT_MARKER.length), "base64").toString("utf8"))
      return decodeExact(BrowserCaptureSchema, parsed)
    } catch {
      throw new Error("Midjourney browser response capture was malformed")
    }
  }
}

export class MidjourneyAdapter implements CaptureAdapter {
  readonly source = "midjourney" as const

  constructor(private readonly options: MidjourneyAdapterOptions = {}) {}

  async collect(cursor: string | null): Promise<{
    readonly captures: ReadonlyArray<IngestCaptureV1>
    readonly nextCursor: string | null
  }> {
    if ((this.options.jobs?.length ?? 0) === 0 && cursor === null && this.options.since === undefined) {
      throw new Error("first Midjourney reconciliation requires --since")
    }
    const browser = this.options.browser ?? new EgoMidjourneyBrowserBridge()
    return collectMidjourneyFeed(await browser.capture(), cursor, this.options)
  }
}
