import { useMemo, useRef, useState } from "react"
import {
  buildDays,
  computeTopOrgs,
  engagementList,
  engagementOf,
  fmtClock,
  nameOf,
  prepSessions,
  type RawSession,
  type Scan,
  type Summaries,
} from "./lib/data"
import { TrailsCtx, type Trails } from "./lib/ctx"
import { useStored } from "./lib/store"
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

  const sessions = useMemo(() => prepSessions(scan.sessions as RawSession[]), [scan])
  const scanTime = useMemo(() => new Date(scan.generatedAt).getTime(), [scan])
  const days = useMemo(() => buildDays(sessions, boundary), [sessions, boundary])
  const topOrgs = useMemo(() => computeTopOrgs(sessions), [sessions])
  const engs = useMemo(() => engagementList(topOrgs, extras), [topOrgs, extras])
  const orgByProject = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of sessions) m.set(s.project, s.org)
    return m
  }, [sessions])

  const tooltipRef = useRef<HTMLDivElement>(null)

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
    const { p, a, b, kind } = hit.dataset
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    tip.innerHTML = `<b>${esc(t.dispName(p!))}</b> · ${fmtClock(+a!)}–${fmtClock(+b! + 1)}<br>${
      kind === "you" ? "you were here, prompting" : "agents running"
    }`
    tip.hidden = false
    tip.style.left = `${Math.min(e.clientX + 14, innerWidth - 340)}px`
    tip.style.top = `${e.clientY + 16}px`
  }

  return (
    <TrailsCtx.Provider value={t}>
      <div onMouseMove={onMove}>
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
          {view === "days" && <DaysView />}
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
