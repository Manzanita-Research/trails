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

interface TooltipState {
  readonly project: string
  readonly start: number
  readonly end: number
  readonly left: number
  readonly top: number
}

const ORGANIZE_PANEL_ID = "organize-projects-panel"

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
  const [openPanel, setOpenPanel] = useState<null | "organize">(null)
  const organizeTriggerRef = useRef<HTMLButtonElement>(null)
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
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)

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
      setOpenPanel(null)
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
    const hit = (event.target as Element).closest?.("rect.hit") as SVGRectElement | null
    if (!hit) {
      setTooltip(null)
      return
    }
    const { p: project, a, b } = hit.dataset
    const start = Number(a)
    const end = Number(b)
    if (!project || !Number.isFinite(start) || !Number.isFinite(end)) {
      setTooltip(null)
      return
    }
    setTooltip({
      project,
      start,
      end,
      left: Math.min(event.clientX + 14, innerWidth - 340),
      top: event.clientY + 16,
    })
  }

  const showView = (nextView: ListView) => {
    setView(nextView)
    setLastListView(nextView)
  }

  return (
    <TrailsCtx.Provider value={trails}>
      <div onMouseMove={onMove} onMouseLeave={() => setTooltip(null)}>
        {onboarding ? (
          <Topbar
            mode="onboarding"
            view={view}
            onView={showView}
            organizeExpanded={openPanel === "organize"}
            organizeControls={ORGANIZE_PANEL_ID}
            organizeTriggerRef={organizeTriggerRef}
            onOrganize={() => setOpenPanel(openPanel === "organize" ? null : "organize")}
          />
        ) : (
          <Topbar
            mode="loaded"
            view={view}
            onView={showView}
            organizeExpanded={openPanel === "organize"}
            organizeControls={ORGANIZE_PANEL_ID}
            organizeTriggerRef={organizeTriggerRef}
            onOrganize={() => setOpenPanel(openPanel === "organize" ? null : "organize")}
            boundary={boundary}
            setBoundary={(value) => mutations.updateSettings({ boundary: value })}
            halo={halo}
            setHalo={(value) => mutations.updateSettings({ halo: value })}
          />
        )}
        {syncError && (
          <div className="sync-error" role="status">
            Sync paused — the last snapshot is still shown. <button onClick={() => void retry()}>retry</button> reconnects.
          </div>
        )}
        <main id="main">
          {onboarding && view === "days" && (
            <FirstTrailGuide
              boundary={boundary}
              halo={halo}
              updateSettings={mutations.updateSettings}
              onOrganize={() => setOpenPanel("organize")}
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
        <SortPanel
          id={ORGANIZE_PANEL_ID}
          open={openPanel === "organize"}
          onClose={() => setOpenPanel(null)}
          fallbackFocusRef={organizeTriggerRef}
        />
        {tooltip && (
          <div className="tooltip" style={{ left: tooltip.left, top: tooltip.top }}>
            <span className="sq" aria-hidden="true" style={{ background: engColor(trails.engOf(tooltip.project)) }} />
            <b>{trails.dispName(tooltip.project)}</b> · {fmtClock(tooltip.start)}–{fmtClock(tooltip.end + 1)} ·{" "}
            {fmtDur(tooltip.end - tooltip.start + 1)}
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {tooltip
            ? `${trails.dispName(tooltip.project)}; ${fmtClock(tooltip.start)} to ${fmtClock(
                tooltip.end + 1,
              )}; ${fmtDur(tooltip.end - tooltip.start + 1)}`
            : ""}
        </span>
      </div>
    </TrailsCtx.Provider>
  )
}

export function App() {
  const { data, loading, error, retry, mutations } = useBootstrap()
  const mode = shellModeOf(data, loading)

  if (mode === "loading") {
    return (
      <>
        <Topbar mode="minimal" />
        <main id="main">
          <section className="view empty-state">
            <h1 className="display">Loading trails…</h1>
          </section>
        </main>
      </>
    )
  }

  if (mode === "hub-error") {
    return (
      <>
        <Topbar mode="minimal" />
        <main id="main">
          <section className="view empty-state">
            <h1 className="display">Trails couldn’t load the hub.</h1>
            <p>
              On one Mac, confirm the hub Mac is awake and open{" "}
              <a href="http://127.0.0.1:7412/">http://127.0.0.1:7412/</a>.
            </p>
            <p>On multiple Macs, use the private URL printed by setup.</p>
            <button className="text-action" onClick={() => void retry()}>
              retry
            </button>
            {error && (
              <details>
                <summary>technical detail</summary>
                <pre>
                  <code>{error}</code>
                </pre>
              </details>
            )}
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
