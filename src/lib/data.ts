// pure data helpers — everything derived from the scan lives here, ui-free

export interface RawSession {
  id: string
  source: "claude" | "codex"
  path: string
  cwd: string | null
  branch: string | null
  start: string
  end: string
  events: number
  userEvents: number
  firstPrompt: string | null
  // [localDate, minuteOfDay, eventCount, userEventCount]
  activity: [string, number, number, number][]
}

export interface Scan {
  generatedAt: string
  timezone: string
  since: string
  sessions: RawSession[]
}

export interface Summaries {
  generatedAt: string
  model: string
  sessions: Record<string, string>
  days: Record<string, string>
}

export interface Session extends RawSession {
  idx: number
  project: string
  org: string
}

export interface Engagement {
  id: string
  name: string
  slot: number | null
}

export interface DayProject {
  all: Set<number>
  user: Set<number>
  sessions: Map<number, { min: number; max: number }>
}

export type DayMap = Map<string, DayProject>

// ---------- naming ----------

export function normalizeCwd(cwd: string | null): string {
  if (!cwd) return "(unknown)"
  let p = cwd.replace(/^\/Users\/[^/]+\//, "")
  const wt = p.indexOf("/.claude/worktrees/")
  if (wt >= 0) p = p.slice(0, wt)
  return p
}

export function orgOf(path: string): string {
  const seg = path.split("/")
  if (seg[0] === "code") return seg[1] ?? "code"
  if (seg[0] === "Documents" && seg[1] === "Codex") return "codex cloud"
  if (seg[0] === "Library") return "icloud"
  if (seg[0] === ".local" || seg[0] === ".config") return "dotfiles"
  return seg[0] || "(unknown)"
}

export function nameOf(path: string): string {
  const seg = path.split("/").filter(Boolean)
  if (seg[0] === "Documents" && seg[1] === "Codex") return seg[3] ?? seg[2] ?? path
  return seg[seg.length - 1] ?? path
}

export function prepSessions(raw: RawSession[]): Session[] {
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

export function computeTopOrgs(sessions: Session[]): string[] {
  const focus = new Map<string, number>()
  for (const s of sessions) focus.set(s.org, (focus.get(s.org) ?? 0) + s.userEvents)
  return [...focus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o]) => o)
}

export function engagementList(topOrgs: string[], extras: string[]): Engagement[] {
  const list: Engagement[] = topOrgs.map((org, i) => ({ id: `org:${org}`, name: org, slot: i + 1 }))
  for (const name of extras) {
    list.push({ id: `custom:${name}`, name, slot: list.length < 8 ? list.length + 1 : null })
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

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export function labelDate(dateStr: string): { dow: string; label: string } {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return { dow: DOW[(d.getUTCDay() + 6) % 7], label: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` }
}

export function buildDays(sessions: Session[], boundary: number): [string, DayMap][] {
  const B = boundary * 60
  const days = new Map<string, DayMap>()
  for (const s of sessions) {
    for (const [date, minute, , u] of s.activity) {
      const workday = minute < B ? shiftDate(date, -1) : date
      const dispMin = minute < B ? minute + 1440 : minute
      let day = days.get(workday)
      if (!day) days.set(workday, (day = new Map()))
      let proj = day.get(s.project)
      if (!proj) day.set(s.project, (proj = { all: new Set(), user: new Set(), sessions: new Map() }))
      proj.all.add(dispMin)
      if (u > 0) proj.user.add(dispMin)
      let span = proj.sessions.get(s.idx)
      if (!span) proj.sessions.set(s.idx, (span = { min: dispMin, max: dispMin }))
      span.min = Math.min(span.min, dispMin)
      span.max = Math.max(span.max, dispMin)
    }
  }
  return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))
}

// union length of user-minutes each expanded ±halo
export function focusMinutes(userMinuteSets: Set<number>[], halo: number): number {
  const mins = [...new Set(userMinuteSets.flatMap((set) => [...set]))].sort((a, b) => a - b)
  if (!mins.length) return 0
  let total = 0
  let start = mins[0] - halo
  let end = mins[0] + halo
  for (let i = 1; i < mins.length; i++) {
    const lo = mins[i] - halo
    const hi = mins[i] + halo
    if (lo <= end + 1) end = Math.max(end, hi)
    else {
      total += end - start + 1
      start = lo
      end = hi
    }
  }
  total += end - start + 1
  return total
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

export const fmtDur = (m: number): string =>
  m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`

export function fmtClock(dispMin: number): string {
  const m = dispMin % 1440
  const h24 = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, "0")
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${mm} ${h24 < 12 ? "am" : "pm"}`
}

export function fmtAgo(ts: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 36) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}
