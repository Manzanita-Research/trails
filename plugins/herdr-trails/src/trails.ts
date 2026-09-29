import { readerToken } from "../../../shared/reader-credential"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { isJsonObject } from "./guards"

export type Source = "claude" | "codex" | "omp" | "pi"
export type ActivityTuple = readonly [date: string, minute: number, events: number, userEvents: number]

export interface TrailsSession {
  readonly id: string
  readonly machine: { readonly id: string; readonly name: string }
  readonly source: Source
  readonly cwd: string | null
  readonly branch: string | null
  readonly start: string
  readonly end: string
  readonly events: number
  readonly userEvents: number
  readonly firstPrompt: string | null
  readonly activity: ReadonlyArray<ActivityTuple>
}

export interface TrailsBootstrap {
  readonly protocolVersion: 1
  readonly revision: number
  readonly generatedAt: string
  readonly timezone: string
  readonly sessions: ReadonlyArray<TrailsSession>
  readonly captures: ReadonlyArray<unknown>
  readonly summaries: {
    readonly sessions: Readonly<Record<string, string>>
    readonly days: Readonly<Record<string, string>>
  }
  readonly preferences: {
    readonly boundary: 4 | 5 | 6 | 7
    readonly halo: 0 | 5 | 10 | 15
    readonly names: Readonly<Record<string, string>>
  }
}

export interface MachineStatus {
  readonly id: string
  readonly name: string
  readonly lastIngestedAt: string | null
  readonly lastCheckedAt: string | null
  readonly lastProcessedAt: string | null
  readonly lastError: string | null
}

export interface MachinesStatus {
  readonly generatedAt: string
  readonly machines: ReadonlyArray<MachineStatus>
}

export interface HarnessStatus {
  readonly harnesses: ReadonlyArray<{ readonly id: string; readonly label: string; readonly available: boolean }>
  readonly active: null | {
    readonly selection: string
    readonly harness: string | null
    readonly state: "unavailable" | "never_ran" | "ok" | "failing"
    readonly lastAttemptAt: number | null
    readonly lastSuccessAt: number | null
    readonly lastErrorClass: string | null
  }
}

export interface TrailsSnapshot {
  readonly bootstrap: TrailsBootstrap
  readonly machines: MachinesStatus | null
  readonly harnesses: HarnessStatus | null
  readonly warnings: ReadonlyArray<string>
  readonly fetchedAt: number
}

export type ServerSource = "environment" | "plugin config" | "Trails collector" | "local hub"

export interface ServerResolution {
  readonly url: string
  readonly source: ServerSource
}

export interface ProjectDay {
  readonly path: string
  readonly name: string
  readonly focusMinutes: number
  readonly sessionCount: number
  readonly firstMinute: number
  readonly lastMinute: number
}

export interface DayRow {
  readonly date: string
  readonly focusMinutes: number
  readonly sessionCount: number
  readonly summary: string | null
  readonly projects: ReadonlyArray<ProjectDay>
}

export interface ThreadRow {
  readonly path: string
  readonly name: string
  readonly focusMinutes: number
  readonly sessions: ReadonlyArray<TrailsSession>
  readonly latestAt: string
}

export interface TrailsModel {
  readonly days: ReadonlyArray<DayRow>
  readonly threads: ReadonlyArray<ThreadRow>
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

function fail(label: string): never {
  throw new Error(`Trails returned invalid ${label} data`)
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") fail(label)
  return value
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null
  return stringValue(value, label)
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(label)
  return value
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!isJsonObject(value)) fail(label)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) result[key] = stringValue(item, label)
  return result
}

function decodeSession(value: unknown): TrailsSession {
  if (!isJsonObject(value) || !isJsonObject(value.machine) || !Array.isArray(value.activity)) fail("session")
  const source = stringValue(value.source, "session source")
  if (!new Set(["claude", "codex", "omp", "pi"]).has(source)) fail("session source")
  const activity = value.activity.map((tuple): ActivityTuple => {
    if (!Array.isArray(tuple) || tuple.length !== 4) fail("session activity")
    return [
      stringValue(tuple[0], "session activity"),
      finiteNumber(tuple[1], "session activity"),
      finiteNumber(tuple[2], "session activity"),
      finiteNumber(tuple[3], "session activity"),
    ]
  })
  return {
    id: stringValue(value.id, "session"),
    machine: {
      id: stringValue(value.machine.id, "session machine"),
      name: stringValue(value.machine.name, "session machine"),
    },
    source: source as Source,
    cwd: nullableString(value.cwd, "session cwd"),
    branch: nullableString(value.branch, "session branch"),
    start: stringValue(value.start, "session"),
    end: stringValue(value.end, "session"),
    events: finiteNumber(value.events, "session"),
    userEvents: finiteNumber(value.userEvents, "session"),
    firstPrompt: nullableString(value.firstPrompt, "session first prompt"),
    activity,
  }
}

export function decodeBootstrap(value: unknown): TrailsBootstrap {
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.sessions) || !Array.isArray(value.captures)) {
    fail("bootstrap")
  }
  if (!isJsonObject(value.summaries) || !isJsonObject(value.preferences)) fail("bootstrap")
  const boundary = finiteNumber(value.preferences.boundary, "preferences")
  const halo = finiteNumber(value.preferences.halo, "preferences")
  if (![4, 5, 6, 7].includes(boundary) || ![0, 5, 10, 15].includes(halo)) fail("preferences")
  return {
    protocolVersion: 1,
    revision: finiteNumber(value.revision, "bootstrap"),
    generatedAt: stringValue(value.generatedAt, "bootstrap"),
    timezone: stringValue(value.timezone, "bootstrap"),
    sessions: value.sessions.map(decodeSession),
    captures: value.captures,
    summaries: {
      sessions: stringRecord(value.summaries.sessions, "session summaries"),
      days: stringRecord(value.summaries.days, "day summaries"),
    },
    preferences: {
      boundary: boundary as 4 | 5 | 6 | 7,
      halo: halo as 0 | 5 | 10 | 15,
      names: stringRecord(value.preferences.names, "project names"),
    },
  }
}

export function decodeMachines(value: unknown): MachinesStatus {
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.machines)) fail("machines")
  return {
    generatedAt: stringValue(value.generatedAt, "machines"),
    machines: value.machines.map((machine): MachineStatus => {
      if (!isJsonObject(machine)) fail("machine")
      return {
        id: stringValue(machine.id, "machine"),
        name: stringValue(machine.name, "machine"),
        lastIngestedAt: nullableString(machine.lastIngestedAt, "machine"),
        lastCheckedAt: nullableString(machine.lastCheckedAt, "machine"),
        lastProcessedAt: nullableString(machine.lastProcessedAt, "machine"),
        lastError: nullableString(machine.lastError, "machine"),
      }
    }),
  }
}

export function decodeHarnesses(value: unknown): HarnessStatus {
  if (!isJsonObject(value) || value.protocolVersion !== 1 || !Array.isArray(value.harnesses)) fail("harnesses")
  const active = value.active
  if (active !== null && !isJsonObject(active)) fail("harnesses")
  return {
    harnesses: value.harnesses.map((harness) => {
      if (!isJsonObject(harness) || typeof harness.available !== "boolean") fail("harness")
      return {
        id: stringValue(harness.id, "harness"),
        label: stringValue(harness.label, "harness"),
        available: harness.available,
      }
    }),
    active: active === null
      ? null
      : {
          selection: stringValue(active.selection, "active harness"),
          harness: nullableString(active.harness, "active harness"),
          state: stringValue(active.state, "active harness") as HarnessStatus["active"] extends infer A
            ? A extends { state: infer S } ? S : never
            : never,
          lastAttemptAt: active.lastAttemptAt === null ? null : finiteNumber(active.lastAttemptAt, "active harness"),
          lastSuccessAt: active.lastSuccessAt === null ? null : finiteNumber(active.lastSuccessAt, "active harness"),
          lastErrorClass: nullableString(active.lastErrorClass, "active harness"),
        },
  }
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]"
}

export function normalizeServerUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error("Trails server must be a valid URL")
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Trails server must be a credential-free base URL with path /")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new Error("Trails server requires HTTPS except on loopback")
  }
  return url.toString()
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw new Error(`Trails configuration is invalid: ${path}`)
  }
}

export function resolveServer(env: NodeJS.ProcessEnv = process.env, home = homedir()): ServerResolution {
  if (env.TRAILS_HERDR_SERVER_URL) {
    return { url: normalizeServerUrl(env.TRAILS_HERDR_SERVER_URL), source: "environment" }
  }

  if (env.HERDR_PLUGIN_CONFIG_DIR) {
    const pluginPath = join(env.HERDR_PLUGIN_CONFIG_DIR, "config.json")
    const pluginConfig = readJson(pluginPath)
    if (pluginConfig !== null) {
      if (!isJsonObject(pluginConfig) || typeof pluginConfig.server !== "string") {
        throw new Error(`Trails plugin configuration must contain a server URL: ${pluginPath}`)
      }
      return { url: normalizeServerUrl(pluginConfig.server), source: "plugin config" }
    }
  }

  const collectorPath = env.TRAILS_COLLECTOR_CONFIG_PATH ?? join(home, ".config/trails/collector.json")
  const collector = readJson(collectorPath)
  if (collector !== null) {
    if (!isJsonObject(collector) || collector.protocolVersion !== 1 || typeof collector.server !== "string") {
      throw new Error(`Trails collector configuration is invalid: ${collectorPath}`)
    }
    return { url: normalizeServerUrl(collector.server), source: "Trails collector" }
  }

  return { url: "http://127.0.0.1:7412/", source: "local hub" }
}

async function responseError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (isJsonObject(body) && isJsonObject(body.error) && typeof body.error.message === "string") return body.error.message
  } catch {}
  return `HTTP ${response.status}`
}

async function requestJson(base: string, path: string, fetcher: FetchLike, timeoutMs: number, token?: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(new URL(path, base), {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(await responseError(response))
    return await response.json()
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Trails did not respond within ${timeoutMs}ms`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchSnapshot(
  server: string,
  options: { readonly fetch?: FetchLike; readonly timeoutMs?: number; readonly now?: () => number; readonly home?: string } = {},
): Promise<TrailsSnapshot> {
  const token = readerToken(server, options.home)
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const warnings: string[] = []
  const optional = async <T>(label: string, path: string, decode: (value: unknown) => T): Promise<T | null> => {
    try {
      return decode(await requestJson(server, path, fetcher, timeoutMs, token))
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : "unavailable"}`)
      return null
    }
  }
  const [bootstrapValue, machines, harnesses] = await Promise.all([
    requestJson(server, "/api/bootstrap", fetcher, timeoutMs, token),
    optional("machines", "/api/machines", decodeMachines),
    optional("summaries", "/api/harnesses", decodeHarnesses),
  ])
  return {
    bootstrap: decodeBootstrap(bootstrapValue),
    machines,
    harnesses,
    warnings,
    fetchedAt: (options.now ?? Date.now)(),
  }
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function workdayOf(date: string, minute: number, boundary: number): string {
  return minute < boundary * 60 ? shiftDate(date, -1) : date
}

export function normalizeProject(cwd: string | null): string {
  if (!cwd) return "(unknown)"
  let path = cwd.replace(/^\/Users\/[^/]+\//, "")
  const worktree = path.indexOf("/.claude/worktrees/")
  if (worktree >= 0) path = path.slice(0, worktree)
  return path
}

export function projectName(path: string): string {
  const segments = path.split("/").filter(Boolean)
  if (segments[0] === "Documents" && segments[1] === "Codex") return segments[3] ?? segments[2] ?? path
  return segments.at(-1) ?? path
}

export function focusMinutes(sets: ReadonlyArray<ReadonlySet<number>>, halo: number): number {
  const minutes = [...new Set(sets.flatMap((set) => [...set]))].sort((a, b) => a - b)
  if (minutes.length === 0) return 0
  let total = 0
  let start = minutes[0] - halo
  let end = minutes[0] + halo
  for (let index = 1; index < minutes.length; index++) {
    const low = minutes[index] - halo
    const high = minutes[index] + halo
    if (low <= end + 1) end = Math.max(end, high)
    else {
      total += end - start + 1
      start = low
      end = high
    }
  }
  return total + end - start + 1
}

export function buildModel(bootstrap: TrailsBootstrap): TrailsModel {
  interface MutableProject {
    path: string
    user: Set<number>
    all: Set<number>
    sessions: Set<string>
  }
  const dayMaps = new Map<string, Map<string, MutableProject>>()
  const threadSessions = new Map<string, TrailsSession[]>()

  for (const session of bootstrap.sessions) {
    const path = normalizeProject(session.cwd)
    const sessions = threadSessions.get(path) ?? []
    sessions.push(session)
    threadSessions.set(path, sessions)
    for (const [date, minute, , userEvents] of session.activity) {
      const workday = workdayOf(date, minute, bootstrap.preferences.boundary)
      const displayMinute = minute < bootstrap.preferences.boundary * 60 ? minute + 1_440 : minute
      const projects = dayMaps.get(workday) ?? new Map<string, MutableProject>()
      const project = projects.get(path) ?? { path, user: new Set<number>(), all: new Set<number>(), sessions: new Set<string>() }
      project.all.add(displayMinute)
      if (userEvents > 0) project.user.add(displayMinute)
      project.sessions.add(session.id)
      projects.set(path, project)
      dayMaps.set(workday, projects)
    }
  }

  const days = [...dayMaps.entries()].map(([date, projects]): DayRow => {
    const projectRows = [...projects.values()].map((project): ProjectDay => {
      const all = [...project.all].sort((a, b) => a - b)
      return {
        path: project.path,
        name: bootstrap.preferences.names[project.path] ?? projectName(project.path),
        focusMinutes: focusMinutes([project.user], bootstrap.preferences.halo),
        sessionCount: project.sessions.size,
        firstMinute: all[0] ?? 0,
        lastMinute: all.at(-1) ?? 0,
      }
    }).sort((a, b) => b.focusMinutes - a.focusMinutes || a.name.localeCompare(b.name))
    return {
      date,
      focusMinutes: focusMinutes([...projects.values()].map((project) => project.user), bootstrap.preferences.halo),
      sessionCount: new Set([...projects.values()].flatMap((project) => [...project.sessions])).size,
      summary: bootstrap.summaries.days[date] ?? null,
      projects: projectRows,
    }
  }).sort((a, b) => b.date.localeCompare(a.date))

  const threads = [...threadSessions.entries()].map(([path, sessions]): ThreadRow => {
    const minutesByDay = new Map<string, Set<number>>()
    for (const session of sessions) {
      for (const [date, minute, , userEvents] of session.activity) {
        if (userEvents === 0) continue
        const day = workdayOf(date, minute, bootstrap.preferences.boundary)
        const set = minutesByDay.get(day) ?? new Set<number>()
        set.add(minute)
        minutesByDay.set(day, set)
      }
    }
    return {
      path,
      name: bootstrap.preferences.names[path] ?? projectName(path),
      focusMinutes: [...minutesByDay.values()].reduce(
        (total, set) => total + focusMinutes([set], bootstrap.preferences.halo),
        0,
      ),
      sessions: [...sessions].sort((a, b) => b.end.localeCompare(a.end)),
      latestAt: sessions.reduce((latest, session) => session.end > latest ? session.end : latest, ""),
    }
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt) || a.name.localeCompare(b.name))

  return { days, threads }
}
