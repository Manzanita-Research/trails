export type Source = "claude" | "codex" | "omp" | "pi"

export type ActivityTuple = readonly [
  localDate: string,
  minute: number,
  eventCount: number,
  userEventCount: number,
]

export const TIMEZONE = "America/Los_Angeles" as const

export function normalizeCwd(cwd: string | null): string {
  if (!cwd) return "(unknown)"
  let path = cwd.replace(/^\/Users\/[^/]+\//, "")
  const worktree = path.indexOf("/.claude/worktrees/")
  if (worktree >= 0) path = path.slice(0, worktree)
  return path
}

export function orgOf(path: string): string {
  const segments = path.split("/")
  if (segments[0] === "code") return segments[1] ?? "code"
  if (segments[0] === "Documents" && segments[1] === "Codex") return "codex cloud"
  if (segments[0] === "Library") return "icloud"
  if (segments[0] === ".local" || segments[0] === ".config") return "dotfiles"
  return segments[0] || "(unknown)"
}

export function nameOf(path: string): string {
  const segments = path.split("/").filter(Boolean)
  if (segments[0] === "Documents" && segments[1] === "Codex") {
    return segments[3] ?? segments[2] ?? path
  }
  return segments[segments.length - 1] ?? path
}

export function computeTopOrgs(
  sessions: ReadonlyArray<{ readonly project?: string; readonly cwd?: string | null; readonly userEvents: number }>,
): string[] {
  const focus = new Map<string, number>()
  for (const session of sessions) {
    const project = session.project ?? normalizeCwd(session.cwd ?? null)
    const org = orgOf(project)
    focus.set(org, (focus.get(org) ?? 0) + session.userEvents)
  }
  return [...focus.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([org]) => org)
}

const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

const localPartsCache = new Map<number, { readonly date: string; readonly minute: number }>()

export function localParts(timestamp: string): { readonly date: string; readonly minute: number } | null {
  const instant = new Date(timestamp).getTime()
  if (Number.isNaN(instant)) return null
  const minuteInstant = Math.floor(instant / 60_000) * 60_000
  const cached = localPartsCache.get(minuteInstant)
  if (cached) return cached
  const parts = Object.fromEntries(
    localFormatter
      .formatToParts(minuteInstant)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>
  const result = {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  }
  localPartsCache.set(minuteInstant, result)
  return result
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function workdayOf(localDate: string, minute: number, boundary: number): string {
  return minute < boundary * 60 ? shiftDate(localDate, -1) : localDate
}

export function workdaysOf(activity: ReadonlyArray<ActivityTuple>, boundary: number): Set<string> {
  const days = new Set<string>()
  for (const [date, minute] of activity) days.add(workdayOf(date, minute, boundary))
  return days
}
