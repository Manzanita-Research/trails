// pure data helpers — everything derived from the scan lives here, ui-free
import { computeTopOrgs, localParts, nameOf, normalizeCwd, orgOf, shiftDate, workdayOf } from "../../shared/domain"
import type { BootstrapCaptureV1, BootstrapSessionV1, BootstrapV1 } from "../../shared/protocol"

export { computeTopOrgs, nameOf, normalizeCwd, orgOf, shiftDate }

export type RawSession = BootstrapSessionV1
export type Summaries = BootstrapV1["summaries"]
export type Capture = BootstrapCaptureV1

export type Session = RawSession & {
  idx: number
  project: string
  org: string
}

export interface Engagement {
  id: string
  name: string
  slot: number | null
}

export interface CaptureSpan {
  capture: Capture
  min: number
  max: number
}

export interface DayProject {
  all: Set<number>
  user: Set<number>
  granola: Set<number>
  midjourney: Set<number>
  sessions: Map<number, { min: number; max: number }>
  captures: Map<string, CaptureSpan>
}

export type DayMap = Map<string, DayProject>

// ---------- naming ----------


export function prepSessions(raw: ReadonlyArray<RawSession>): Session[] {
  return raw.map((s, i) => {
    const project = normalizeCwd(s.cwd)
    return {
      ...s,
      idx: i,
      project,
      org: orgOf(project),
      firstPrompt: s.firstPrompt?.replace(/^[0-9a-f]{8}-[0-9a-f-]{27,}\s*/i, "").trim() || null,
    }
  })
}

// ---------- engagements ----------


export function engagementList(
  topOrgs: string[],
  customEngagements: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  assignments: Record<string, string>,
): Engagement[] {
  const list: Engagement[] = topOrgs.map((org, index) => ({ id: `org:${org}`, name: org, slot: index + 1 }))
  const topIds = new Set(list.map((engagement) => engagement.id))
  const assignedOrgIds = [...new Set(Object.values(assignments).filter((id) => id.startsWith("org:")))]
  for (const id of assignedOrgIds) {
    if (!topIds.has(id)) list.push({ id, name: id.slice(4), slot: null })
  }
  for (const [index, engagement] of customEngagements.entries()) {
    const slot = topOrgs.length + index + 1
    list.push({ ...engagement, slot: slot <= 8 ? slot : null })
  }
  list.push({ id: "elsewhere", name: "elsewhere", slot: null })
  return list
}

export function engagementOf(
  project: string,
  org: string,
  assignments: Record<string, string>,
  list: Engagement[],
): Engagement {
  const assigned = assignments[project]
  if (assigned) {
    const found = list.find((e) => e.id === assigned)
    if (found) return found
  }
  return list.find((e) => e.id === `org:${org}`) ?? list.find((e) => e.id === "elsewhere")!
}

export const engColor = (eng: Engagement): string => (eng.slot ? `var(--s${eng.slot})` : "var(--muted)")

// ---------- day building ----------


const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const DOW_FULL = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const MON_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]

export function labelDate(dateStr: string): { dow: string; label: string } {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return { dow: DOW[(d.getUTCDay() + 6) % 7], label: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` }
}

// "Friday, July 24" — the day page display heading
export function fullDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return `${DOW_FULL[(d.getUTCDay() + 6) % 7]}, ${MON_FULL[d.getUTCMonth()]} ${d.getUTCDate()}`
}

// "thursday" — pager links
export function dowName(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return DOW_FULL[(d.getUTCDay() + 6) % 7].toLowerCase()
}

// the configured-zone workday that "now" belongs to, honoring the morning boundary
export function workdayToday(boundary: number, timeZone: string, now = Date.now()): string {
  const local = localParts(now, timeZone)
  return workdayOf(local.date, local.minute, boundary)
}

// ---------- day credits ----------

export function credit(mins: number): number {
  const h = mins / 60
  if (h >= 5.5) return 1
  if (h >= 2.5) return 0.5
  if (h >= 1) return 0.25
  return 0
}

export const creditWord: Record<number, string> = { 1: "full day", 0.5: "half day", 0.25: "quarter day" }

// 2.75 → "2¾" — week totals in day-credits
export function fmtCredits(n: number): string {
  const whole = Math.floor(n)
  const frac = { 0.25: "¼", 0.5: "½", 0.75: "¾" }[Math.round((n - whole) * 4) / 4] ?? ""
  return whole ? `${whole}${frac}` : frac || "0"
}

export const CREATIVE_ELSEWHERE_PROJECT = "creative elsewhere"

function emptyDayProject(): DayProject {
  return {
    all: new Set(),
    user: new Set(),
    granola: new Set(),
    midjourney: new Set(),
    sessions: new Map(),
    captures: new Map(),
  }
}

export function firstMinuteOf(project: DayProject): number {
  return Math.min(...project.all, ...project.granola, ...project.midjourney)
}

export function lastMinuteOf(project: DayProject): number {
  return Math.max(...project.all, ...project.granola, ...project.midjourney)
}

export function buildDays(
  sessions: ReadonlyArray<Session>,
  captures: ReadonlyArray<Capture>,
  boundary: number,
): [string, DayMap][] {
  const B = boundary * 60
  const days = new Map<string, DayMap>()
  const projectFor = (workday: string, project: string): DayProject => {
    let day = days.get(workday)
    if (!day) days.set(workday, (day = new Map()))
    let value = day.get(project)
    if (!value) day.set(project, (value = emptyDayProject()))
    return value
  }
  for (const session of sessions) {
    for (const [date, minute, , userEvents] of session.activity) {
      const workday = minute < B ? shiftDate(date, -1) : date
      const displayMinute = minute < B ? minute + 1440 : minute
      const project = projectFor(workday, session.project)
      project.all.add(displayMinute)
      if (userEvents > 0) project.user.add(displayMinute)
      let span = project.sessions.get(session.idx)
      if (!span) project.sessions.set(session.idx, (span = { min: displayMinute, max: displayMinute }))
      span.min = Math.min(span.min, displayMinute)
      span.max = Math.max(span.max, displayMinute)
    }
  }
  for (const capture of captures) {
    const projectName = capture.project ?? CREATIVE_ELSEWHERE_PROJECT
    for (const [date, minute] of capture.attentionMinutes) {
      const workday = minute < B ? shiftDate(date, -1) : date
      const displayMinute = minute < B ? minute + 1440 : minute
      const project = projectFor(workday, projectName)
      project[capture.source].add(displayMinute)
      let span = project.captures.get(capture.id)
      if (!span) {
        project.captures.set(capture.id, (span = { capture, min: displayMinute, max: displayMinute }))
      }
      span.min = Math.min(span.min, displayMinute)
      span.max = Math.max(span.max, displayMinute)
    }
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}

// interval union: coding points receive ±halo; capture minutes remain exact
export function attentionMinutes(
  codingUserSets: ReadonlyArray<ReadonlySet<number>>,
  captureMinuteSets: ReadonlyArray<ReadonlySet<number>>,
  halo: number,
): number {
  const intervals: Array<[number, number]> = []
  for (const minutes of codingUserSets) {
    for (const minute of minutes) intervals.push([minute - halo, minute + halo])
  }
  for (const minutes of captureMinuteSets) {
    for (const minute of minutes) intervals.push([minute, minute])
  }
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  if (intervals.length === 0) return 0
  let total = 0
  let [start, end] = intervals[0]!
  for (const [nextStart, nextEnd] of intervals.slice(1)) {
    if (nextStart <= end + 1) end = Math.max(end, nextEnd)
    else {
      total += end - start + 1
      start = nextStart
      end = nextEnd
    }
  }
  return total + end - start + 1
}

// runs of consecutive minutes → [start, end] pairs
export function runsOf(minuteSet: Set<number>): [number, number][] {
  const mins = [...minuteSet].sort((a, b) => a - b)
  const runs: [number, number][] = []
  for (const m of mins) {
    const last = runs[runs.length - 1]
    if (last && m <= last[1] + 1) last[1] = m
    else runs.push([m, m])
  }
  return runs
}

// ---------- formatting ----------

// nbsp (\u00a0) between parts so a duration never breaks across lines, wherever it lands
export const fmtDur = (m: number): string =>
  m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`

export function fmtClock(dispMin: number): string {
  const m = dispMin % 1440
  const h24 = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, "0")
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${mm} ${h24 < 12 ? "am" : "pm"}`
}

// "08:31" — tabular session-log times
export function fmtClock24(dispMin: number): string {
  const m = dispMin % 1440
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`
}

export function fmtAgo(ts: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 36) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}
