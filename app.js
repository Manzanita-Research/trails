// trails prototype — days / week / threads / project detail over scanned session metadata

const $ = (sel, el = document) => el.querySelector(sel)
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)]
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`trails.${key}`)
      return v ? JSON.parse(v) : fallback
    } catch {
      return fallback
    }
  },
  set(key, value) {
    localStorage.setItem(`trails.${key}`, JSON.stringify(value))
  },
}

const state = {
  view: "days",
  lastListView: "days",
  projectKey: null,
  boundary: 6,
  halo: 10,
  assignments: store.get("assignments", {}),
  extraEngagements: store.get("extraEngagements", []),
  names: store.get("names", {}),
  pocket: store.get("pocket", []),
  openRows: new Set(),
}

// ---------- load + normalize ----------

const raw = await (await fetch("data/scan.json")).json()
const scanTime = new Date(raw.generatedAt).getTime()

// llm summaries are optional — the ui degrades to first-prompt snippets without them
const summaries = await fetch("data/summaries.json")
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)
const sessSummary = (id) => summaries?.sessions?.[id]
const daySummary = (date, project) => summaries?.days?.[`${date}|${project}`]

function normalizeCwd(cwd) {
  if (!cwd) return "(unknown)"
  let p = cwd.replace(/^\/Users\/[^/]+\//, "")
  const wt = p.indexOf("/.claude/worktrees/")
  if (wt >= 0) p = p.slice(0, wt)
  return p
}

function orgOf(path) {
  const seg = path.split("/")
  if (seg[0] === "code") return seg[1] ?? "code"
  if (seg[0] === "Documents" && seg[1] === "Codex") return "codex cloud"
  if (seg[0] === "Library") return "icloud"
  if (seg[0] === ".local" || seg[0] === ".config") return "dotfiles"
  return seg[0] || "(unknown)"
}

function nameOf(path) {
  const seg = path.split("/").filter(Boolean)
  if (seg[0] === "Documents" && seg[1] === "Codex") return seg[3] ?? seg[2] ?? path
  return seg[seg.length - 1] ?? path
}

const dispName = (project) => state.names[project] ?? nameOf(project)

const sessions = raw.sessions.map((s, i) => {
  const project = normalizeCwd(s.cwd)
  const firstPrompt = s.firstPrompt?.replace(/^[0-9a-f]{8}-[0-9a-f-]{27,}\s*/i, "").trim() || null
  return { ...s, idx: i, project, org: orgOf(project), name: nameOf(project), firstPrompt }
})

// ---------- engagements ----------

const orgFocus = new Map()
for (const s of sessions) orgFocus.set(s.org, (orgFocus.get(s.org) ?? 0) + s.userEvents)
const topOrgs = [...orgFocus.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([o]) => o)

function engagements() {
  const list = topOrgs.map((org, i) => ({ id: `org:${org}`, name: org, slot: i + 1 }))
  for (const name of state.extraEngagements) {
    list.push({ id: `custom:${name}`, name, slot: list.length < 8 ? list.length + 1 : null })
  }
  list.push({ id: "elsewhere", name: "elsewhere", slot: null })
  return list
}

function engagementOf(project, org) {
  const assigned = state.assignments[project]
  const list = engagements()
  if (assigned && list.some((e) => e.id === assigned)) return list.find((e) => e.id === assigned)
  const auto = list.find((e) => e.id === `org:${org}`)
  return auto ?? list.find((e) => e.id === "elsewhere")
}

const engColor = (eng) => (eng.slot ? `var(--s${eng.slot})` : "var(--muted)")

// ---------- day building ----------

function shiftDate(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
function labelDate(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  return { dow: DOW[(d.getUTCDay() + 6) % 7], label: `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` }
}

function buildDays() {
  const B = state.boundary * 60
  const days = new Map()
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
function focusMinutes(userMinuteSets, halo) {
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

const fmtDur = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, "0")}m` : `${Math.round(m)}m`)

function fmtClock(dispMin) {
  const m = dispMin % 1440
  const h24 = Math.floor(m / 60)
  const mm = String(m % 60).padStart(2, "0")
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${mm} ${h24 < 12 ? "am" : "pm"}`
}

const fmtAgo = (ts) => {
  const mins = Math.max(0, Math.round((scanTime - new Date(ts).getTime()) / 60000))
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 36) return `${Math.round(mins / 60)}h ago`
  return `${Math.round(mins / 1440)}d ago`
}

// runs of consecutive minutes → [start, end] pairs
function runsOf(minuteSet) {
  const mins = [...minuteSet].sort((a, b) => a - b)
  const runs = []
  for (const m of mins) {
    const last = runs[runs.length - 1]
    if (last && m <= last[1] + 1) last[1] = m
    else runs.push([m, m])
  }
  return runs
}

// ---------- svg lanes ----------

function laneMarks(data, X, y, laneH, color, project) {
  let out = ""
  for (const [a, b] of runsOf(data.all)) {
    const w = Math.max(2, X(b + 1) - X(a))
    out += `<rect class="hit" data-p="${esc(project)}" data-a="${a}" data-b="${b}" data-kind="agent" x="${X(a)}" y="${y + 3}" width="${w}" height="${laneH - 6}" rx="2" fill="${color}" opacity="0.28"/>`
  }
  for (const [a, b] of runsOf(data.user)) {
    const w = Math.max(2.5, X(b + 1) - X(a))
    out += `<rect class="hit" data-p="${esc(project)}" data-a="${a}" data-b="${b}" data-kind="you" x="${X(a)}" y="${y + 1.5}" width="${w}" height="${laneH - 3}" rx="2.5" fill="${color}"/>`
  }
  return out
}

function hourGrid(X, topPad, H, withLabels = true) {
  let g = ""
  for (let h = state.boundary; h <= state.boundary + 24; h += 3) {
    const x = X(h * 60)
    const hh = h % 24
    const lbl = hh === 0 ? "12am" : hh === 12 ? "noon" : hh < 12 ? `${hh}am` : `${hh - 12}pm`
    g += `<line x1="${x}" y1="${topPad - 6}" x2="${x}" y2="${H - 12}" stroke="var(--hairline)" stroke-width="1"/>`
    if (withLabels) g += `<text x="${x}" y="${topPad - 9}" fill="var(--muted)" font-size="10" text-anchor="middle">${lbl}</text>`
  }
  return g
}

function makeX(labelW, plotW) {
  const x0 = state.boundary * 60
  return (min) => labelW + ((min - x0) / 1440) * plotW
}

function dayTimelineSVG(dayProjects, widthPx) {
  const labelW = 190
  const plotW = Math.max(320, widthPx - labelW)
  const laneH = 16
  const laneGap = 6
  const topPad = 18
  const projects = [...dayProjects.entries()].sort((a, b) => Math.min(...a[1].all) - Math.min(...b[1].all))
  const H = topPad + projects.length * (laneH + laneGap) + 14
  const X = makeX(labelW, plotW)

  let lanes = ""
  projects.forEach(([project, data], i) => {
    const y = topPad + i * (laneH + laneGap)
    const eng = engagementOf(project, orgOf(project))
    const name = dispName(project)
    lanes += `<text x="${labelW - 10}" y="${y + laneH - 4}" fill="var(--ink-2)" font-size="11.5" text-anchor="end">${esc(name.length > 24 ? name.slice(0, 23) + "…" : name)}</text>`
    lanes += laneMarks(data, X, y, laneH, engColor(eng), project)
  })

  return `<svg class="day-svg" width="${widthPx}" height="${H}" viewBox="0 0 ${widthPx} ${H}" role="img" aria-label="activity timeline">${hourGrid(X, topPad, H)}${lanes}</svg>`
}

// ---------- days view ----------

function renderDays() {
  const el = $("#view-days")
  const days = buildDays()
  const widthPx = Math.min(1032, el.clientWidth || 1032) - 42
  const halo = state.halo

  let html = `<p class="view-intro">Days are shaped around your sleep, not midnight — work until ${state.boundary - 1} am still belongs to the evening before. <strong>Solid marks are minutes you were actually there</strong>, prompting and steering. The pale wash is agents running while your attention was somewhere else.</p>`

  for (const [date, projMap] of days) {
    const { dow, label } = labelDate(date)
    const allUser = [...projMap.values()].map((p) => p.user)
    const focus = focusMinutes(allUser, halo)
    const agentMin = new Set([...projMap.values()].flatMap((p) => [...p.all])).size
    const sessCount = new Set([...projMap.values()].flatMap((p) => [...p.sessions.keys()])).size

    const byEng = new Map()
    for (const [project, data] of projMap) {
      const eng = engagementOf(project, orgOf(project))
      if (!byEng.has(eng.id)) byEng.set(eng.id, { eng, sets: [] })
      byEng.get(eng.id).sets.push(data.user)
    }
    const chips = [...byEng.values()]
      .map(({ eng, sets }) => ({ eng, focus: focusMinutes(sets, halo) }))
      .filter((c) => c.focus > 0)
      .sort((a, b) => b.focus - a.focus)
      .map(
        ({ eng, focus: f }) =>
          `<span class="eng-chip"><span class="dot" style="background:${engColor(eng)}"></span>${esc(eng.name)} <b>${fmtDur(f)}</b></span>`,
      )
      .join("")

    const rows = [...projMap.entries()]
      .map(([project, data]) => ({ project, data, focus: focusMinutes([data.user], halo) }))
      .sort((a, b) => b.focus - a.focus)
      .map(({ project, data, focus: f }) => {
        const eng = engagementOf(project, orgOf(project))
        const rowKey = `${date}|${project}`
        const open = state.openRows.has(rowKey)
        const detail = open
          ? `<div class="proj-detail">${dayNote(date, project)}${[...data.sessions.entries()]
              .sort((a, b) => a[1].min - b[1].min)
              .map(([idx, span]) => sessLine(sessions[idx], span))
              .join("")}</div>`
          : ""
        return `<div class="proj-row">
          <button class="proj-summary" data-row="${esc(rowKey)}">
            <span class="dot" style="background:${engColor(eng)}"></span>
            <span class="proj-name proj-link" data-open-project="${esc(project)}">${esc(dispName(project))}</span>
            <span class="proj-org">${esc(eng.name)}</span>
            <span class="proj-meta">
              <span><b>${fmtDur(f)}</b> you</span>
              <span class="quiet">${fmtDur(data.all.size)} agents</span>
              <span class="quiet">${data.sessions.size} session${data.sessions.size === 1 ? "" : "s"}</span>
            </span>
            <span class="proj-caret">${open ? "▾" : "▸"}</span>
          </button>
          ${detail}
        </div>`
      })
      .join("")

    html += `<article class="day-card">
      <div class="day-head">
        <span class="day-date">${label}</span><span class="day-dow">${dow}</span>
        <span class="day-stats">
          <span><b>${fmtDur(focus)}</b> your attention</span>
          <span><b>${fmtDur(agentMin)}</b> agents active</span>
          <span><b>${sessCount}</b> sessions</span>
        </span>
      </div>
      <div class="day-engagements">${chips}</div>
      ${dayTimelineSVG(projMap, widthPx)}
      <div class="proj-rows">${rows}</div>
    </article>`
  }
  el.innerHTML = html
}

function sessLine(s, span) {
  const sum = sessSummary(s.id)
  const text = sum ? esc(sum) : s.firstPrompt ? esc(s.firstPrompt) : "<em>no prompt captured</em>"
  const hover = sum && s.firstPrompt ? ` title="opening prompt: ${esc(s.firstPrompt)}"` : ""
  return `<div class="sess">
    <span class="sess-time">${fmtClock(span.min)} – ${fmtClock(span.max)}</span>
    <span class="sess-src">${s.source === "claude" ? "claude" : "codex"}</span>
    <span class="sess-prompt${sum ? " is-summary" : ""}"${hover}>${text}</span>
  </div>`
}

// per-project day rollup, shown above the session list when the summarizer has run
function dayNote(date, project) {
  const sum = daySummary(date, project)
  return sum ? `<p class="day-summary">${esc(sum)}</p>` : ""
}

// ---------- project detail view ----------

function renderProject() {
  const el = $("#view-project")
  const project = state.projectKey
  const halo = state.halo
  const days = buildDays()
  const eng = engagementOf(project, orgOf(project))
  const engs = engagements()

  const projDays = days.filter(([, projMap]) => projMap.has(project))
  const allUserSets = projDays.map(([, m]) => m.get(project).user)
  const totalFocus = focusMinutes(allUserSets, halo)
  const totalAgent = projDays.reduce((sum, [, m]) => sum + m.get(project).all.size, 0)
  const sessCount = new Set(projDays.flatMap(([, m]) => [...m.get(project).sessions.keys()])).size

  const widthPx = Math.min(1032, el.clientWidth || 1032) - 42
  const labelW = 90
  const plotW = Math.max(320, widthPx - labelW - 32)
  const X = makeX(labelW, plotW)
  const laneH = 16

  const dayBlocks = projDays
    .map(([date, projMap]) => {
      const data = projMap.get(project)
      const f = focusMinutes([data.user], halo)
      const { dow, label } = labelDate(date)
      const H = 30
      const svg = `<svg class="day-svg" width="${widthPx - 32}" height="${H}" viewBox="0 0 ${widthPx - 32} ${H}">${hourGrid(X, 10, H + 8, false)}${laneMarks(data, X, 7, laneH, engColor(eng), project)}</svg>`
      const sess = [...data.sessions.entries()]
        .sort((a, b) => a[1].min - b[1].min)
        .map(([idx, span]) => sessLine(sessions[idx], span))
        .join("")
      return `<div class="detail-day">
        <div class="detail-day-head">
          <span class="day-date">${label}</span><span class="day-dow">${dow}</span>
          <span class="day-stats"><span><b>${fmtDur(f)}</b> you</span><span><b>${fmtDur(data.all.size)}</b> agents</span></span>
        </div>
        ${dayNote(date, project)}
        ${svg}
        <div>${sess}</div>
      </div>`
    })
    .join("")

  el.innerHTML = `
    <button class="back-btn" id="back-btn">← back to ${state.lastListView}</button>
    <div class="detail-head">
      <span class="dot" style="background:${engColor(eng)}"></span>
      <h1 class="detail-title">${esc(dispName(project))}</h1>
      <button class="rename-btn" id="rename-btn" title="rename">rename</button>
      <select id="detail-eng">${engs
        .map((e) => `<option value="${esc(e.id)}" ${e.id === eng.id ? "selected" : ""}>${esc(e.name)}</option>`)
        .join("")}<option value="__new__">+ new engagement…</option></select>
    </div>
    <p class="detail-path">~/${esc(project)}</p>
    <div class="detail-stats">
      <span class="stat"><b>${fmtDur(totalFocus)}</b><span>your attention</span></span>
      <span class="stat"><b>${fmtDur(totalAgent)}</b><span>agent minutes</span></span>
      <span class="stat"><b>${sessCount}</b><span>sessions</span></span>
      <span class="stat"><b>${projDays.length}</b><span>days touched</span></span>
    </div>
    ${dayBlocks}`

  $("#back-btn").addEventListener("click", () => {
    state.view = state.lastListView
    syncTabs()
    render()
  })
  $("#rename-btn").addEventListener("click", () => {
    const next = prompt("Display name for this project (empty to reset):", dispName(project))
    if (next === null) return
    if (next.trim()) state.names[project] = next.trim()
    else delete state.names[project]
    store.set("names", state.names)
    render()
  })
  $("#detail-eng").addEventListener("change", (e) => {
    let value = e.target.value
    if (value === "__new__") {
      const name = prompt("Name the engagement (a client, a practice, a life area):")?.trim()
      if (!name) return render()
      if (!state.extraEngagements.includes(name)) state.extraEngagements.push(name)
      store.set("extraEngagements", state.extraEngagements)
      value = `custom:${name}`
    }
    state.assignments[project] = value
    store.set("assignments", state.assignments)
    render()
  })
}

function openProject(project) {
  if (state.view !== "project") state.lastListView = state.view
  state.view = "project"
  state.projectKey = project
  syncTabs()
  render()
  scrollTo({ top: 0 })
}

// ---------- week view ----------

function renderWeek() {
  const el = $("#view-week")
  const days = buildDays()
  const halo = state.halo

  const perDay = new Map()
  for (const [date, projMap] of days) {
    const byEng = new Map()
    for (const [project, data] of projMap) {
      const eng = engagementOf(project, orgOf(project))
      if (!byEng.has(eng.id)) byEng.set(eng.id, { eng, sets: [] })
      byEng.get(eng.id).sets.push(data.user)
    }
    perDay.set(
      date,
      new Map([...byEng.entries()].map(([id, { eng, sets }]) => [id, { eng, focus: focusMinutes(sets, halo) }])),
    )
  }

  const credit = (mins) => {
    const h = mins / 60
    if (h >= 5.5) return 1
    if (h >= 2.5) return 0.5
    if (h >= 1) return 0.25
    return 0
  }
  const creditLabel = { 1: "1", 0.5: "½", 0.25: "¼" }

  const weeks = new Map()
  for (const [date] of days) {
    const d = new Date(`${date}T12:00:00Z`)
    const monday = shiftDate(date, -((d.getUTCDay() + 6) % 7))
    if (!weeks.has(monday)) weeks.set(monday, [])
    weeks.get(monday).push(date)
  }

  let html = `<p class="view-intro">Your attention-hours per engagement, rolled up the way you actually bill: <strong>roughly 3 hours is a half day, 6+ is a full day</strong>, and partial days can smash together across the week. Tune the attention halo in settings until these totals feel honest, then sort any misfiled projects.</p>`

  for (const [monday, weekDays] of [...weeks.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    const dates = Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
    const engIds = new Map()
    for (const date of weekDays) for (const [id, { eng }] of perDay.get(date) ?? []) engIds.set(id, eng)

    const rows = [...engIds.values()]
      .map((eng) => {
        let weekMins = 0
        let weekCredits = 0
        const cells = dates
          .map((date) => {
            const f = perDay.get(date)?.get(eng.id)?.focus ?? 0
            weekMins += f
            const c = credit(f)
            weekCredits += c
            if (!f) return `<td><span class="cell-empty">—</span></td>`
            return `<td><span class="cell-credit">${c ? creditLabel[c] : "·"}</span><span class="cell-hours">${fmtDur(f)}</span></td>`
          })
          .join("")
        return { eng, weekMins, weekCredits, cells }
      })
      .filter((r) => r.weekMins > 0)
      .sort((a, b) => b.weekMins - a.weekMins)

    const endLabel = labelDate(shiftDate(monday, 6))
    const startLabel = labelDate(monday)
    html += `<div class="week-block">
      <h2 class="week-title">${startLabel.label} – ${endLabel.label}</h2>
      <table class="week-table">
        <thead><tr><th>Engagement</th>${dates.map((d) => `<th>${labelDate(d).dow}</th>`).join("")}<th>Days</th><th>Hours</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `<tr>
                <td><span class="eng-cell"><span class="dot" style="background:${engColor(r.eng)}"></span>${esc(r.eng.name)}</span></td>
                ${r.cells}
                <td><span class="cell-credit">${r.weekCredits || "—"}</span></td>
                <td>${fmtDur(r.weekMins)}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      <p class="credit-note">¼ ≥ 1h · ½ ≥ 2.5h · full ≥ 5.5h of attention. Credits are a starting point for your invoice, not the invoice.</p>
    </div>`
  }
  el.innerHTML = html
}

// ---------- threads view ----------

function renderThreads() {
  const el = $("#view-threads")
  const byProject = new Map()
  for (const s of sessions) {
    let p = byProject.get(s.project)
    if (!p) byProject.set(s.project, (p = { sessions: [], userEvents: 0 }))
    p.sessions.push(s)
    p.userEvents += s.userEvents
  }

  const cols = { motion: [], waiting: [], resting: [], dormant: [] }
  for (const [project, p] of byProject) {
    const latest = p.sessions.reduce((a, b) => (a.end > b.end ? a : b))
    const ageMin = (scanTime - new Date(latest.end).getTime()) / 60000
    const lastBucket = latest.activity[latest.activity.length - 1]
    const agentHadLastWord = lastBucket && lastBucket[3] === 0
    const card = { project, latest, ageMin, agentHadLastWord, userEvents: p.userEvents }
    if (ageMin < 60) cols.motion.push(card)
    else if (ageMin < 60 * 36) cols.waiting.push(card)
    else if (ageMin < 60 * 24 * 7) cols.resting.push(card)
    else cols.dormant.push(card)
  }
  for (const key of Object.keys(cols)) cols[key].sort((a, b) => a.ageMin - b.ageMin)

  const colDefs = [
    ["motion", "In motion", "touched in the last hour"],
    ["waiting", "Waiting on you", "finished or paused, last day or so"],
    ["resting", "Resting", "quiet this week"],
    ["dormant", "Dormant", "quiet longer — and that's fine"],
  ]

  const cardHTML = (c) => {
    const eng = engagementOf(c.project, orgOf(c.project))
    const note =
      c.ageMin >= 60 && c.ageMin < 60 * 36 && c.agentHadLastWord
        ? " · agent had the last word — output may be unseen"
        : ""
    return `<div class="thread-card">
      <span class="proj-name proj-link" data-open-project="${esc(c.project)}"><span class="dot" style="background:${engColor(eng)}"></span>${esc(dispName(c.project))}</span>
      <div class="thread-when">${fmtAgo(c.latest.end)}${note}</div>
      ${(() => {
        const snip = sessSummary(c.latest.id) ?? c.latest.firstPrompt
        return snip ? `<div class="thread-snippet">${esc(snip)}</div>` : ""
      })()}
    </div>`
  }

  const grid = colDefs
    .map(([key, title, sub]) => {
      const cards = cols[key]
      const shown = cards.slice(0, 10)
      return `<div>
        <h2 class="thread-col-head"><b>${title} · ${cards.length}</b><span>${sub}</span></h2>
        ${shown.map(cardHTML).join("")}
        ${cards.length > shown.length ? `<div class="thread-when" style="padding:4px 2px">+ ${cards.length - shown.length} more</div>` : ""}
      </div>`
    })
    .join("")

  const pocketItems = state.pocket
    .map(
      (item, i) => `<div class="pocket-item">
        <span class="when">${new Date(item.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
        <span>${esc(item.text)}</span>
        <button class="del" data-pocket-del="${i}" title="let it go">✕</button>
      </div>`,
    )
    .join("")

  el.innerHTML = `<p class="view-intro">Threads don't have deadlines or priority scores. They're <strong>in motion, waiting on you, or resting</strong> — and resting is a real state, not a failure state. Snapshot as of the last scan.</p>
    <div class="threads-grid">${grid}</div>
    <div class="pocket">
      <h2>Divergence pocket</h2>
      <p class="pocket-hint">Mid-thread idea? Catch it here without abandoning what you're doing. It'll be waiting when you surface.</p>
      <form class="pocket-form" id="pocket-form">
        <input id="pocket-input" placeholder="the idea, before it evaporates" autocomplete="off" />
        <button type="submit">catch</button>
      </form>
      <div id="pocket-list">${pocketItems}</div>
    </div>`

  $("#pocket-form").addEventListener("submit", (e) => {
    e.preventDefault()
    const text = $("#pocket-input").value.trim()
    if (!text) return
    state.pocket.unshift({ text, at: Date.now() })
    store.set("pocket", state.pocket)
    renderThreads()
  })
}

// ---------- sort panel ----------

function renderSortPanel() {
  const list = $("#sort-list")
  const engs = engagements()
  const byProject = new Map()
  for (const s of sessions) {
    let p = byProject.get(s.project)
    if (!p) byProject.set(s.project, (p = { userEvents: 0, org: s.org }))
    p.userEvents += s.userEvents
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1].userEvents - a[1].userEvents)
  list.innerHTML = rows
    .map(([project, p]) => {
      const current = engagementOf(project, p.org)
      const opts = engs
        .map((e) => `<option value="${esc(e.id)}" ${e.id === current.id ? "selected" : ""}>${esc(e.name)}</option>`)
        .join("")
      return `<div class="sort-row">
        <span class="dot" style="background:${engColor(current)}; width:9px; height:9px; border-radius:50%; flex:none"></span>
        <span class="names"><span class="proj-name proj-link" data-open-project="${esc(project)}">${esc(dispName(project))}</span><span class="proj-org">${esc(project)}</span></span>
        <select data-project="${esc(project)}">${opts}<option value="__new__">+ new engagement…</option></select>
      </div>`
    })
    .join("")
}

$("#sort-list").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-project]")
  if (!sel) return
  let value = sel.value
  if (value === "__new__") {
    const name = prompt("Name the engagement (a client, a practice, a life area):")?.trim()
    if (!name) return renderSortPanel()
    if (!state.extraEngagements.includes(name)) state.extraEngagements.push(name)
    store.set("extraEngagements", state.extraEngagements)
    value = `custom:${name}`
  }
  state.assignments[sel.dataset.project] = value
  store.set("assignments", state.assignments)
  renderSortPanel()
  render()
})

// ---------- tooltip ----------

const tooltip = $("#tooltip")
document.addEventListener("mousemove", (e) => {
  const hit = e.target.closest?.("rect.hit")
  if (!hit) {
    tooltip.hidden = true
    return
  }
  const { p, a, b, kind } = hit.dataset
  tooltip.innerHTML = `<b>${esc(dispName(p))}</b> · ${fmtClock(+a)}–${fmtClock(+b + 1)}<br>${kind === "you" ? "you were here, prompting" : "agents running"}`
  tooltip.hidden = false
  tooltip.style.left = `${Math.min(e.clientX + 14, innerWidth - 340)}px`
  tooltip.style.top = `${e.clientY + 16}px`
})

// ---------- wiring ----------

function syncTabs() {
  $$(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.view === state.view))
}

function render() {
  $$(".view").forEach((v) => (v.hidden = true))
  const view = $(`#view-${state.view}`)
  view.hidden = false
  if (state.view === "days") renderDays()
  else if (state.view === "week") renderWeek()
  else if (state.view === "project") renderProject()
  else renderThreads()
}

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab")
  if (!tab) return
  state.view = tab.dataset.view
  state.lastListView = tab.dataset.view
  syncTabs()
  render()
})

// one delegated click handler: project links (anywhere), row toggles, pocket deletes
document.addEventListener("click", (e) => {
  const link = e.target.closest("[data-open-project]")
  if (link) {
    e.preventDefault()
    e.stopPropagation()
    $("#sort-panel").hidden = true
    openProject(link.dataset.openProject)
    return
  }
  const rowBtn = e.target.closest("[data-row]")
  if (rowBtn) {
    const key = rowBtn.dataset.row
    state.openRows.has(key) ? state.openRows.delete(key) : state.openRows.add(key)
    renderDays()
    return
  }
  const del = e.target.closest("[data-pocket-del]")
  if (del) {
    state.pocket.splice(Number(del.dataset.pocketDel), 1)
    store.set("pocket", state.pocket)
    renderThreads()
  }
})

$("#boundary").addEventListener("change", (e) => {
  state.boundary = Number(e.target.value)
  render()
})
$("#halo").addEventListener("change", (e) => {
  state.halo = Number(e.target.value)
  render()
})
$("#sort-toggle").addEventListener("click", () => {
  const panel = $("#sort-panel")
  panel.hidden = !panel.hidden
  if (!panel.hidden) renderSortPanel()
})
$("#sort-close").addEventListener("click", () => ($("#sort-panel").hidden = true))
$("#settings-toggle").addEventListener("click", (e) => {
  e.stopPropagation()
  const pop = $("#settings-pop")
  pop.hidden = !pop.hidden
})
document.addEventListener("click", (e) => {
  const pop = $("#settings-pop")
  if (!pop.hidden && !e.target.closest("#settings-pop") && !e.target.closest("#settings-toggle")) pop.hidden = true
})

let resizeTimer
addEventListener("resize", () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => (state.view === "days" || state.view === "project") && render(), 200)
})

render()
