import {
  buildModel,
  type DayRow,
  type ServerResolution,
  type ThreadRow,
  type TrailsSession,
  type TrailsSnapshot,
} from "./trails"

export type Screen = "days" | "week" | "threads" | "status"

export interface ViewState {
  readonly screen: Screen
  readonly selected: Readonly<Record<Screen, number>>
  readonly detail: boolean
  readonly help: boolean
  readonly loading: boolean
  readonly error: string | null
}

interface StyledLine {
  readonly text: string
  readonly tone?: "accent" | "muted" | "danger" | "heading" | "selected" | "good"
}

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[38;2;103;208;202m",
  green: "\u001b[38;2;145;190;122m",
  red: "\u001b[38;2;224;108;117m",
  paper: "\u001b[38;2;226;221;210m",
  selected: "\u001b[48;2;45;54;58m\u001b[38;2;238;232;218m",
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`
  return `${Math.floor(minutes / 60)}h ${String(Math.round(minutes % 60)).padStart(2, "0")}m`
}

export function formatClock(minute: number): string {
  const value = minute % 1_440
  const hour = Math.floor(value / 60)
  return `${String(hour).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
}

function formatDate(date: string, long = false): string {
  const value = new Date(`${date}T12:00:00Z`)
  return new Intl.DateTimeFormat("en-US", long
    ? { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" }
    : { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(value)
}

function formatDateTime(value: string | null, now: number): string {
  if (!value) return "never"
  const elapsed = Math.max(0, now - new Date(value).getTime())
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 2_160) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1_440)}d ago`
}

function fit(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  if (width === 1) return "…"
  return `${value.slice(0, width - 1)}…`
}

function pad(value: string, width: number): string {
  const fitted = fit(value, width)
  return fitted + " ".repeat(Math.max(0, width - fitted.length))
}

function wrap(value: string, width: number, limit: number): string[] {
  if (width < 1 || limit < 1) return []
  const words = value.trim().split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (current && current.length + word.length + 1 > width) {
      lines.push(fit(current, width))
      current = word
      if (lines.length === limit) break
    } else current = current ? `${current} ${word}` : word
  }
  if (lines.length < limit && current) lines.push(fit(current, width))
  if (words.length > 0 && lines.length === limit) {
    const joined = lines.join(" ")
    if (joined.length < value.trim().length) lines[lines.length - 1] = fit(`${lines.at(-1)}…`, width)
  }
  return lines
}

function style(line: StyledLine, width: number, colors: boolean): string {
  const text = line.tone === "selected" ? pad(line.text, width) : fit(line.text, width)
  if (!colors) return text
  const code = line.tone === "accent" ? ANSI.cyan
    : line.tone === "muted" ? ANSI.dim
      : line.tone === "danger" ? ANSI.red
        : line.tone === "heading" ? `${ANSI.bold}${ANSI.paper}`
          : line.tone === "selected" ? ANSI.selected
            : line.tone === "good" ? ANSI.green
              : ""
  return code ? `${code}${text}${ANSI.reset}` : text
}

function progressBar(minutes: number, maximum: number, width: number): string {
  const filled = maximum <= 0 ? 0 : Math.max(1, Math.round((minutes / maximum) * width))
  return `${"█".repeat(Math.min(width, filled))}${"░".repeat(Math.max(0, width - filled))}`
}

function dayList(days: ReadonlyArray<DayRow>, selected: number, width: number, bodyHeight: number): StyledLine[] {
  if (days.length === 0) return [{ text: "No collected days yet.", tone: "muted" }]
  const start = Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), days.length - bodyHeight))
  return days.slice(start, start + bodyHeight).map((day, offset) => {
    const projects = day.projects.slice(0, 3).map((project) => project.name).join(", ")
    const left = `${formatDate(day.date).padEnd(12)} ${formatDuration(day.focusMinutes).padStart(7)}  ${String(day.sessionCount).padStart(2)} sessions`
    const text = width >= 78 ? `${left}  ${projects}` : left
    return { text: `${start + offset === selected ? "›" : " "} ${text}`, tone: start + offset === selected ? "selected" : undefined }
  })
}

function dayDetail(day: DayRow, width: number, bodyHeight: number): StyledLine[] {
  const lines: StyledLine[] = [
    { text: `${formatDate(day.date, true)} · ${formatDuration(day.focusMinutes)} · ${day.sessionCount} sessions`, tone: "heading" },
  ]
  if (day.summary) {
    lines.push({ text: "" })
    lines.push(...wrap(day.summary, width, 3).map((text): StyledLine => ({ text })))
  }
  lines.push({ text: "" }, { text: "Projects", tone: "accent" })
  for (const project of day.projects) {
    const span = `${formatClock(project.firstMinute)}–${formatClock(project.lastMinute)}`
    const right = `${formatDuration(project.focusMinutes)} · ${project.sessionCount} sessions · ${span}`
    const gap = Math.max(2, width - project.name.length - right.length)
    lines.push({ text: `${project.name}${" ".repeat(gap)}${right}` })
  }
  return lines.slice(0, bodyHeight)
}

function weekView(days: ReadonlyArray<DayRow>, width: number, bodyHeight: number): StyledLine[] {
  const week = days.slice(0, 7)
  if (week.length === 0) return [{ text: "No collected week yet.", tone: "muted" }]
  const maximum = Math.max(...week.map((day) => day.focusMinutes), 1)
  const barWidth = Math.max(8, Math.min(30, width - 35))
  const total = week.reduce((sum, day) => sum + day.focusMinutes, 0)
  const lines: StyledLine[] = [
    { text: `Latest seven workdays · ${formatDuration(total)}`, tone: "heading" },
    { text: "" },
  ]
  for (const day of week) {
    lines.push({
      text: `${formatDate(day.date).padEnd(12)} ${progressBar(day.focusMinutes, maximum, barWidth)}  ${formatDuration(day.focusMinutes).padStart(7)}  ${day.projects[0]?.name ?? "—"}`,
    })
  }
  return lines.slice(0, bodyHeight)
}

function threadList(threads: ReadonlyArray<ThreadRow>, selected: number, width: number, bodyHeight: number): StyledLine[] {
  if (threads.length === 0) return [{ text: "No project threads yet.", tone: "muted" }]
  const start = Math.max(0, Math.min(selected - Math.floor(bodyHeight / 2), threads.length - bodyHeight))
  return threads.slice(start, start + bodyHeight).map((thread, offset) => {
    const right = `${formatDuration(thread.focusMinutes)} · ${thread.sessions.length} sessions · ${formatDate(thread.latestAt.slice(0, 10))}`
    const nameWidth = Math.max(8, width - right.length - 5)
    return {
      text: `${start + offset === selected ? "›" : " "} ${fit(thread.name, nameWidth).padEnd(nameWidth)}  ${right}`,
      tone: start + offset === selected ? "selected" : undefined,
    }
  })
}

function sessionLine(session: TrailsSession, summary: string | undefined, width: number): StyledLine[] {
  const prefix = `${session.end.slice(0, 10)}  ${session.source.padEnd(6)}  ${session.machine.name}`
  const subject = summary ?? session.firstPrompt ?? "No prompt captured"
  return [
    { text: prefix, tone: "muted" },
    ...wrap(subject, Math.max(10, width - 2), 2).map((text): StyledLine => ({ text: `  ${text}` })),
  ]
}

function threadDetail(
  thread: ThreadRow,
  summaries: Readonly<Record<string, string>>,
  width: number,
  bodyHeight: number,
): StyledLine[] {
  const lines: StyledLine[] = [
    { text: `${thread.name} · ${formatDuration(thread.focusMinutes)} · ${thread.sessions.length} sessions`, tone: "heading" },
    { text: thread.path, tone: "muted" },
    { text: "" },
  ]
  for (const session of thread.sessions) {
    lines.push(...sessionLine(session, summaries[session.id], width), { text: "" })
    if (lines.length >= bodyHeight) break
  }
  return lines.slice(0, bodyHeight)
}

function statusView(snapshot: TrailsSnapshot, resolution: ServerResolution, width: number, bodyHeight: number, now: number): StyledLine[] {
  const { bootstrap, machines, harnesses } = snapshot
  const lines: StyledLine[] = [
    { text: "Connection", tone: "heading" },
    { text: `${new URL(resolution.url).host} · ${resolution.source} · revision ${bootstrap.revision}` },
    { text: `${bootstrap.sessions.length} sessions · ${bootstrap.captures.length} captures · ${bootstrap.timezone}`, tone: "muted" },
    { text: "" },
    { text: "Collectors", tone: "accent" },
  ]
  if (!machines) lines.push({ text: "Machine status unavailable.", tone: "danger" })
  else if (machines.machines.length === 0) lines.push({ text: "No collectors have checked in.", tone: "muted" })
  else {
    for (const machine of machines.machines) {
      const state = machine.lastError ? `error: ${machine.lastError}` : `checked ${formatDateTime(machine.lastCheckedAt, now)}`
      const gap = Math.max(2, width - machine.name.length - state.length)
      lines.push({ text: `${machine.name}${" ".repeat(gap)}${state}`, tone: machine.lastError ? "danger" : "good" })
    }
  }
  lines.push({ text: "" }, { text: "Summaries", tone: "accent" })
  if (!harnesses) lines.push({ text: "Harness status unavailable.", tone: "danger" })
  else if (!harnesses.active) lines.push({ text: "Off", tone: "muted" })
  else {
    const active = harnesses.active
    const selected = active.harness ?? active.selection
    const detail = active.lastErrorClass ? `${active.state} · ${active.lastErrorClass}` : active.state
    lines.push({ text: `${selected} · ${detail}`, tone: active.state === "ok" ? "good" : active.state === "failing" ? "danger" : undefined })
    const available = harnesses.harnesses.filter((harness) => harness.available).map((harness) => harness.label).join(", ")
    lines.push({ text: `Available: ${available || "none"}`, tone: "muted" })
  }
  for (const warning of snapshot.warnings) lines.push({ text: warning, tone: "danger" })
  return lines.slice(0, bodyHeight)
}

function helpView(width: number): StyledLine[] {
  return [
    { text: "Keys", tone: "heading" },
    { text: "1 days   2 week   3 threads   4 status" },
    { text: "j/k or ↑/↓ move   enter open   esc back" },
    { text: "r refresh   ? help   q quit" },
    { text: "" },
    { text: fit("The server URL is read without modification from TRAILS_HERDR_SERVER_URL, this plugin's config.json, or ~/.config/trails/collector.json.", width), tone: "muted" },
  ]
}

export function renderDashboard(options: {
  readonly snapshot: TrailsSnapshot | null
  readonly resolution: ServerResolution
  readonly state: ViewState
  readonly width: number
  readonly height: number
  readonly now?: number
  readonly colors?: boolean
}): string {
  const width = Math.max(20, options.width)
  const height = Math.max(8, options.height)
  const colors = options.colors ?? true
  const now = options.now ?? Date.now()
  const selectedTab = (label: string, screen: Screen): string => options.state.screen === screen ? `[${label.toUpperCase()}]` : label
  const status = options.state.loading ? "refreshing…"
    : options.state.error ? "offline"
      : options.snapshot ? `synced ${new Date(options.snapshot.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
        : "starting…"
  const header: StyledLine[] = [
    { text: `TRAILS  ${status}`, tone: options.state.error ? "danger" : "accent" },
    { text: `1 ${selectedTab("days", "days")}   2 ${selectedTab("week", "week")}   3 ${selectedTab("threads", "threads")}   4 ${selectedTab("status", "status")}`, tone: "muted" },
    { text: "─".repeat(width), tone: "muted" },
  ]
  const footerHeight = 2
  const bodyHeight = Math.max(1, height - header.length - footerHeight)
  let body: StyledLine[]
  if (width < 42) body = [{ text: "Widen this pane to at least 42 columns.", tone: "danger" }]
  else if (options.state.help) body = helpView(width)
  else if (!options.snapshot) {
    body = [
      { text: options.state.loading ? "Connecting to Trails…" : "Trails is offline.", tone: options.state.loading ? "muted" : "danger" },
      { text: new URL(options.resolution.url).host, tone: "muted" },
      { text: "" },
      { text: options.state.error ?? "Press r to retry. Trails will also retry automatically.", tone: options.state.error ? "danger" : "muted" },
    ]
  } else {
    const model = buildModel(options.snapshot.bootstrap)
    const selection = options.state.selected[options.state.screen]
    if (options.state.screen === "days") {
      const day = model.days[Math.min(selection, Math.max(0, model.days.length - 1))]
      body = options.state.detail && day
        ? dayDetail(day, width, bodyHeight)
        : dayList(model.days, selection, width, bodyHeight)
    } else if (options.state.screen === "week") body = weekView(model.days, width, bodyHeight)
    else if (options.state.screen === "threads") {
      const thread = model.threads[Math.min(selection, Math.max(0, model.threads.length - 1))]
      body = options.state.detail && thread
        ? threadDetail(thread, options.snapshot.bootstrap.summaries.sessions, width, bodyHeight)
        : threadList(model.threads, selection, width, bodyHeight)
    } else body = statusView(options.snapshot, options.resolution, width, bodyHeight, now)
  }
  body = body.slice(0, bodyHeight)
  while (body.length < bodyHeight) body.push({ text: "" })
  const footer: StyledLine[] = [
    { text: "─".repeat(width), tone: "muted" },
    { text: options.state.detail ? "esc back  ·  r refresh  ·  ? keys  ·  q quit" : "j/k move  ·  enter open  ·  r refresh  ·  ? keys  ·  q quit", tone: "muted" },
  ]
  return [...header, ...body, ...footer].map((line) => style(line, width, colors)).join("\n")
}
