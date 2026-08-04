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
import { WelcomeView } from "./components/WelcomeView"
import { FirstTrailGuide } from "./components/FirstTrailGuide"

type ShellMode = "loading" | "hub-error" | "welcome" | "onboarding" | "loaded"

function shellModeOf(data: BootstrapV1 | null, loading: boolean): ShellMode {
  if (data === null) return loading ? "loading" : "hub-error"
  if (data.sessions.length === 0) return "welcome"
  return data.preferences.onboardingVersion < 1 ? "onboarding" : "loaded"
}

const backLabels: Record<ListView, string> = { days: "days", week: "the week", threads: "threads" }

function LoadedApp({
  bootstrap,
  mutations,
  syncError,
  retry,
  onboarding,
}: {
  readonly bootstrap: BootstrapV1
  readonly mutations: BootstrapMutations
  readonly syncError: string | null
  readonly retry: () => Promise<void>
  readonly onboarding: boolean
}) {
  const { boundary, halo, assignments, customEngagements, names, pocket } = bootstrap.preferences
  const [view, setView] = useState<ListView | "project">("days")
  const [lastListView, setLastListView] = useState<ListView>("days")
  const [projectKey, setProjectKey] = useState<string | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const [dayIdx, setDayIdx] = useState(0)

  const sessions = useMemo(() => prepSessions(bootstrap.sessions), [bootstrap.sessions])
  const nowTime = useMemo(() => new Date(bootstrap.generatedAt).getTime(), [bootstrap.generatedAt])
  const indexedAt = useMemo(
    () => (bootstrap.indexedAt === null ? null : new Date(bootstrap.indexedAt).getTime()),
    [bootstrap.indexedAt],
  )
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
    nowTime,
    indexedAt,
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

  const showView = (nextView: ListView) => {
    setView(nextView)
    setLastListView(nextView)
  }

  return (
    <TrailsCtx.Provider value={trails}>
      <div onMouseMove={onMove}>
        {onboarding ? (
          <Topbar
            mode="onboarding"
            view={view}
            onView={showView}
            onToggleSort={() => setSortOpen(!sortOpen)}
          />
        ) : (
          <Topbar
            mode="loaded"
            view={view}
            onView={showView}
            onToggleSort={() => setSortOpen(!sortOpen)}
            boundary={boundary}
            setBoundary={(value) => mutations.updateSettings({ boundary: value })}
            halo={halo}
            setHalo={(value) => mutations.updateSettings({ halo: value })}
          />
        )}
        {syncError && (
          <div className="sync-error" role="status">
            Sync paused — showing the last loaded snapshot. <button onClick={() => void retry()}>retry</button>
          </div>
        )}
        <main id="main">
          {onboarding && view === "days" && (
            <FirstTrailGuide
              boundary={boundary}
              halo={halo}
              updateSettings={mutations.updateSettings}
              onOrganize={() => setSortOpen(true)}
            />
          )}
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

export function App() {
  const { data, loading, error, retry, mutations } = useBootstrap()
  const mode = shellModeOf(data, loading)

  if (mode === "loading" || mode === "hub-error") {
    return (
      <>
        <Topbar mode="minimal" />
        <main id="main">
          <section className="view empty-state">
            <h1 className="display">{mode === "loading" ? "Loading trails…" : "Trails couldn't reach the hub"}</h1>
            {mode === "hub-error" && error && <p>{error}</p>}
            {mode === "hub-error" && <button onClick={() => void retry()}>retry</button>}
          </section>
        </main>
      </>
    )
  }

  if (mode === "welcome") {
    return (
      <>
        <Topbar mode="minimal" />
        <main id="main">
          <WelcomeView hubUrl={data!.hubUrl} retry={retry} syncError={error} />
        </main>
      </>
    )
  }

  return (
    <LoadedApp
      bootstrap={data!}
      mutations={mutations}
      syncError={error}
      retry={retry}
      onboarding={mode === "onboarding"}
    />
  )
}
