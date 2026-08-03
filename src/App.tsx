import { useEffect, useMemo, useRef, useState } from "react"
import type { BootstrapV1 } from "../shared/protocol"
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
} from "./lib/data"
import { TrailsCtx, type Trails } from "./lib/ctx"
import { useBootstrap, type BootstrapMutations } from "./lib/api"
import { Topbar, type ListView } from "./components/Topbar"
import { DaysView } from "./components/DaysView"
import { WeekView } from "./components/WeekView"
import { ThreadsView } from "./components/ThreadsView"
import { ProjectView } from "./components/ProjectView"
import { SortPanel } from "./components/SortPanel"

const backLabels: Record<ListView, string> = { days: "days", week: "the week", threads: "threads" }

function LoadedApp({
  bootstrap,
  mutations,
  syncError,
  retry,
}: {
  readonly bootstrap: BootstrapV1
  readonly mutations: BootstrapMutations
  readonly syncError: string | null
  readonly retry: () => Promise<void>
}) {
  const { boundary, halo, assignments, customEngagements, names, pocket } = bootstrap.preferences
  const [view, setView] = useState<ListView | "project">("days")
  const [lastListView, setLastListView] = useState<ListView>("days")
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [dayIdx, setDayIdx] = useState(0)

  const sessions = useMemo(() => prepSessions(bootstrap.sessions), [bootstrap.sessions])
  const scanTime = useMemo(() => new Date(bootstrap.generatedAt).getTime(), [bootstrap.generatedAt])
  const days = useMemo(() => buildDays(sessions, boundary), [sessions, boundary])
  const topOrgs = useMemo(() => computeTopOrgs(sessions), [sessions])
  const engs = useMemo(
    () => engagementList(topOrgs, customEngagements, assignments),
    [topOrgs, customEngagements, assignments],
  )
  const orgByProject = useMemo(() => {
    const projects = new Map<string, string>()
    for (const session of sessions) projects.set(session.project, session.org)
    return projects
  }, [sessions])
  const tooltipRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (view !== "days") return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      const tag = (event.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return
      setDayIdx((index) => {
        const next = event.key === "ArrowLeft" ? index + 1 : index - 1
        return Math.max(0, Math.min(days.length - 1, next))
      })
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [view, days.length])

  const trails: Trails = {
    sessions,
    summaries: bootstrap.summaries,
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
      const index = days.findIndex(([day]) => day === date)
      if (index < 0) return
      setDayIdx(index)
      setView("days")
      setLastListView("days")
      scrollTo({ top: 0 })
    },
    assign: async (project, engagementId) => {
      await mutations.updateProject({ project, engagementId })
    },
    addEngagement: async (name) => (await mutations.createEngagement(name)).id,
    rename: async (project, displayName) => {
      await mutations.updateProject({ project, displayName })
    },
    pocket,
    addPocket: async (text) => {
      await mutations.addPocket(text)
    },
    deletePocket: async (id) => {
      await mutations.deletePocket(id)
    },
    sessSummary: (id) => bootstrap.summaries.sessions[id],
    daySummary: (date, project) => bootstrap.summaries.days[`${date}|${project}`],
  }

  const onMove = (event: React.MouseEvent) => {
    const tip = tooltipRef.current
    if (!tip) return
    const hit = (event.target as Element).closest?.("rect.hit") as SVGRectElement | null
    if (!hit) {
      tip.hidden = true
      return
    }
    const { p, a, b } = hit.dataset
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    tip.innerHTML = `<span class="sq" style="background:${engColor(trails.engOf(p!))}"></span><b>${escape(
      trails.dispName(p!),
    )}</b> · ${fmtClock(+a!)}–${fmtClock(+b! + 1)} · ${fmtDur(+b! - +a! + 1)}`
    tip.hidden = false
    tip.style.left = `${Math.min(event.clientX + 14, innerWidth - 340)}px`
    tip.style.top = `${event.clientY + 16}px`
  }

  return (
    <TrailsCtx.Provider value={trails}>
      <div onMouseMove={onMove}>
        <Topbar
          view={view}
          onView={(nextView) => {
            setView(nextView)
            setLastListView(nextView)
          }}
          onToggleSort={() => setSortOpen(!sortOpen)}
          boundary={boundary}
          setBoundary={(value) => mutations.updateSettings({ boundary: value })}
          halo={halo}
          setHalo={(value) => mutations.updateSettings({ halo: value })}
        />
        {syncError && (
          <div className="sync-error" role="status">
            Sync paused — showing the last loaded snapshot. <button onClick={() => void retry()}>retry</button>
          </div>
        )}
        <main id="main">
          {sessions.length === 0 ? (
            <section className="view empty-state">
              <h1 className="display">No sessions yet</h1>
              <p>Configure this Mac's collector, then run one collection:</p>
              <code>trails configure collector --server https://your-mini.ts.net/</code>
              <br />
              <code>trails collect --once</code>
            </section>
          ) : (
            <>
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
            </>
          )}
        </main>
        <SortPanel open={sortOpen} onClose={() => setSortOpen(false)} />
        <div ref={tooltipRef} className="tooltip" hidden />
      </div>
    </TrailsCtx.Provider>
  )
}

export function App() {
  const { data, loading, error, retry, mutations } = useBootstrap()
  if (!data) {
    return (
      <main id="main">
        <section className="view empty-state">
          <h1 className="display">{loading ? "Loading trails…" : "Trails couldn't reach the Mini"}</h1>
          {error && <p>{error}</p>}
          {!loading && <button onClick={() => void retry()}>retry</button>}
        </section>
      </main>
    )
  }
  return <LoadedApp bootstrap={data} mutations={mutations} syncError={error} retry={retry} />
}
