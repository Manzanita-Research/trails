import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import {
  buildDays,
  computeTopOrgs,
  engagementList,
  engagementOf,
  engColor,
  fmtClock,
  fmtDur,
  nameOf,
  prepSessions,
  type RawSession,
  type Scan,
  type Summaries,
} from "./lib/data"
import { TrailsCtx, type Trails } from "./lib/ctx"
import { useStored } from "./lib/store"
import { themeForProject, themeVariables } from "./lib/projectThemes"
import { Topbar, type ListView } from "./components/Topbar"
import { DaysView } from "./components/DaysView"
import { WeekView } from "./components/WeekView"
import { ThreadsView } from "./components/ThreadsView"
import { ProjectView } from "./components/ProjectView"
import { SortPanel } from "./components/SortPanel"

const backLabels: Record<ListView, string> = { days: "days", week: "the week", threads: "threads" }

export function App({ scan, summaries }: { scan: Scan; summaries: Summaries | null }) {
  const [boundary, setBoundary] = useStored("boundary", 6)
  const [halo, setHalo] = useStored("halo", 10)
  const [assignments, setAssignments] = useStored<Record<string, string>>("assignments", {})
  const [extras, setExtras] = useStored<string[]>("extraEngagements", [])
  const [names, setNames] = useStored<Record<string, string>>("names", {})

  const [view, setView] = useState<ListView | "project">("days")
  const [lastListView, setLastListView] = useState<ListView>("days")
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [dayIdx, setDayIdx] = useState(0)

  const sessions = useMemo(() => prepSessions(scan.sessions as RawSession[]), [scan])
  const scanTime = useMemo(() => new Date(scan.generatedAt).getTime(), [scan])
  const days = useMemo(() => buildDays(sessions, boundary), [sessions, boundary])
  const topOrgs = useMemo(() => computeTopOrgs(sessions), [sessions])
  const engs = useMemo(() => engagementList(topOrgs, extras), [topOrgs, extras])
  const activeTheme = useMemo(() => themeForProject(view === "project" ? projectKey : null), [view, projectKey])
  const activeThemeStyle = useMemo(() => themeVariables(activeTheme) as CSSProperties, [activeTheme])
  const orgByProject = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sessions) m.set(s.project, s.org)
    return m
  }, [sessions])

  const tooltipRef = useRef<HTMLDivElement>(null)

  // arrow keys page between days when the days view is up
  useEffect(() => {
    if (view !== "days") return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return
      setDayIdx((i) => {
        const next = e.key === "ArrowLeft" ? i + 1 : i - 1
        return Math.max(0, Math.min(days.length - 1, next))
      })
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [view, days.length])

  const t: Trails = {
    sessions,
    summaries,
    scanTime,
    boundary,
    halo,
    days,
    engs,
    engOf: (project) => engagementOf(project, orgByProject.get(project) ?? "(unknown)", assignments, engs),
    dispName: (project) => names[project] ?? nameOf(project),
    openProject: (project) => {
      if (view !== "project") setLastListView(view)
      setProjectKey(project)
      setView("project")
      setSortOpen(false)
      scrollTo({ top: 0 })
    },
    openDay: (date) => {
      const i = days.findIndex(([d]) => d === date)
      if (i < 0) return
      setDayIdx(i)
      setView("days")
      setLastListView("days")
      scrollTo({ top: 0 })
    },
    assign: (project, engId) => setAssignments({ ...assignments, [project]: engId }),
    addEngagement: (name) => {
      if (!extras.includes(name)) setExtras([...extras, name])
      return `custom:${name}`
    },
    rename: (project, name) => {
      const next = { ...names }
      if (name) next[project] = name
      else delete next[project]
      setNames(next)
    },
    sessSummary: (id) => summaries?.sessions[id],
    daySummary: (date, project) => summaries?.days[`${date}|${project}`],
  }

  // delegated tooltip over every timeline rect
  const onMove = (e: React.MouseEvent) => {
    const tip = tooltipRef.current
    if (!tip) return
    const hit = (e.target as Element).closest?.("rect.hit") as SVGRectElement | null
    if (!hit) {
      tip.hidden = true
      return
    }
    const { p, a, b } = hit.dataset
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    tip.innerHTML = `<span class="sq" style="background:${engColor(t.engOf(p!))}"></span><b>${esc(
      t.dispName(p!),
    )}</b> · ${fmtClock(+a!)}–${fmtClock(+b! + 1)} · ${fmtDur(+b! - +a! + 1)}`
    tip.hidden = false
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 340)}px`
    tip.style.top = `${e.clientY + 16}px`
  }

  return (
    <TrailsCtx.Provider value={t}>
      <div
        className="app-shell"
        data-project-theme={activeTheme.id}
        data-theme-surface={activeTheme.treatment.surface}
        data-theme-heading={activeTheme.treatment.heading}
        style={activeThemeStyle}
        onMouseMove={onMove}
      >
        <Topbar
          view={view}
          onView={(v) => {
            setView(v)
            setLastListView(v)
          }}
          onToggleSort={() => setSortOpen(!sortOpen)}
          boundary={boundary}
          setBoundary={setBoundary}
          halo={halo}
          setHalo={setHalo}
        />
        <main id="main">
          {view === "days" && <DaysView dayIdx={dayIdx} onDayIdx={setDayIdx} />}
          {view === "week" && <WeekView />}
          {view === "threads" && <ThreadsView />}
          {view === "project" && projectKey && (
            <ProjectView
              project={projectKey}
              backLabel={backLabels[lastListView]}
              onBack={() => setView(lastListView)}
            />
          )}
        </main>
        <SortPanel open={sortOpen} onClose={() => setSortOpen(false)} />
        <div ref={tooltipRef} className="tooltip" hidden />
      </div>
    </TrailsCtx.Provider>
  )
}
