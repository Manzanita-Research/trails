import { useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react"
import packageMetadata from "../package.json"
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
import { Topbar, type AppView, type ListView } from "./components/Topbar"
import { DaysView } from "./components/DaysView"
import { WeekView } from "./components/WeekView"
import { ThreadsView } from "./components/ThreadsView"
import { ProjectView } from "./components/ProjectView"
import { SettingsView } from "./components/SettingsView"
import { WelcomeView } from "./components/WelcomeView"
import { FirstTrailGuide } from "./components/FirstTrailGuide"
import { FeedbackPanel } from "./components/FeedbackPanel"
import { FEEDBACK_ENDPOINT, type FeedbackSafeContextInput } from "./lib/feedback"

type ShellMode = "loading" | "hub-error" | "welcome" | "onboarding" | "loaded"

interface FeedbackLocation {
  readonly view: "days" | "week" | "threads" | "project" | "settings"
  readonly workDate: string | null
}

interface TooltipState {
  readonly project: string
  readonly start: number
  readonly end: number
  readonly left: number
  readonly top: number
}

const FEEDBACK_PANEL_ID = "feedback-panel"

function shellModeOf(data: BootstrapV1 | null, loading: boolean): ShellMode {
  if (data === null) return loading ? "loading" : "hub-error"
  if (data.sessions.length === 0 && data.captures.length === 0) return "welcome"
  return data.preferences.onboardingVersion < 1 ? "onboarding" : "loaded"
}

const backLabels: Record<ListView, string> = { days: "days", week: "the week", threads: "threads" }

function LoadedApp({
  bootstrap,
  mutations,
  syncError,
  retry,
  onboarding,
  feedbackOpen,
  setFeedbackOpen,
  feedbackTriggerRef,
  setFeedbackLocation,
}: {
  readonly bootstrap: BootstrapV1
  readonly mutations: BootstrapMutations
  readonly syncError: string | null
  readonly retry: () => Promise<void>
  readonly onboarding: boolean
  readonly feedbackOpen: boolean
  readonly setFeedbackOpen: Dispatch<SetStateAction<boolean>>
  readonly feedbackTriggerRef: RefObject<HTMLButtonElement | null>
  readonly setFeedbackLocation: Dispatch<SetStateAction<FeedbackLocation>>
}
) {
  const { boundary, halo, assignments, customEngagements, names, pocket } = bootstrap.preferences
  const [view, setView] = useState<AppView>("days")
  const [lastListView, setLastListView] = useState<ListView>("days")
  const [projectBackView, setProjectBackView] = useState<ListView | "settings">("days")
  const [settingsEntry, setSettingsEntry] = useState<"top" | "projects" | "summarization">("top")
  const [projectKey, setProjectKey] = useState<string | null>(null)
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
    const workDate = view === "days" ? (days[dayIdx]?.[0] ?? null) : null
    setFeedbackLocation({ view, workDate })
  }, [dayIdx, days, setFeedbackLocation, view])

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
    timezone: bootstrap.timezone,
    days,
    engs,
    engOf: (project) => engagementOf(project, orgByProject.get(project) ?? "(unknown)", assignments, engs),
    dispName: (project) => names[project] ?? nameOf(project),
    openProject: (project) => {
      if (view === "settings") {
        setProjectBackView("settings")
      } else if (view !== "project") {
        setLastListView(view)
        setProjectBackView(view)
      }
      setProjectKey(project)
      setView("project")
      setFeedbackOpen(false)
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

  const showSettings = (entry: "top" | "projects" = "top") => {
    if (view !== "project" && view !== "settings") setLastListView(view)
    setSettingsEntry(entry)
    setView("settings")
  }

  return (
    <TrailsCtx.Provider value={trails}>
      <div onMouseMove={onMove} onMouseLeave={() => setTooltip(null)}>
        <Topbar
          mode={onboarding ? "onboarding" : "loaded"}
          view={view}
          onView={showView}
          onSettings={() => showSettings("top")}
          feedbackExpanded={feedbackOpen}
          feedbackControls={FEEDBACK_PANEL_ID}
          feedbackTriggerRef={feedbackTriggerRef}
          onFeedback={() => setFeedbackOpen((current) => !current)}
        />
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
              onOpenProjects={() => showSettings("projects")}
            />
          )}
          {view === "days" && <DaysView dayIdx={dayIdx} onDayIdx={setDayIdx} />}
          {view === "week" && <WeekView />}
          {view === "threads" && <ThreadsView />}
          {view === "project" && projectKey && (
            <ProjectView
              project={projectKey}
              backLabel={projectBackView === "settings" ? "settings" : backLabels[projectBackView]}
              onBack={() => setView(projectBackView)}
            />
          )}
          {view === "settings" && (
            <SettingsView
              bootstrap={bootstrap}
              mutations={mutations}
              entryTarget={settingsEntry}
              onBack={() => setView(lastListView)}
              onTimezoneSaved={() => setDayIdx(0)}
            />
          )}
        </main>
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
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackLocation, setFeedbackLocation] = useState<FeedbackLocation>({ view: "days", workDate: null })
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const feedbackTriggerRef = useRef<HTMLButtonElement>(null)
  const mode = shellModeOf(data, loading)

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const toggleFeedback = () => setFeedbackOpen((current) => !current)
  const feedbackTriggerProps = {
    feedbackExpanded: feedbackOpen,
    feedbackControls: FEEDBACK_PANEL_ID,
    feedbackTriggerRef,
    onFeedback: toggleFeedback,
  }
  const feedbackView: FeedbackSafeContextInput["view"] =
    mode === "onboarding" || mode === "loaded" ? feedbackLocation.view : mode
  const contextInput: FeedbackSafeContextInput = {
    appVersion: packageMetadata.version,
    view: feedbackView,
    bootstrap: mode === "loading" || mode === "hub-error" ? null : data,
    workDate:
      feedbackView === "days" || feedbackView === "project" ? feedbackLocation.workDate : null,
    viewport,
    syncError: error !== null,
  }

  let shell
  if (mode === "loading") {
    shell = (
      <>
        <Topbar mode="minimal" {...feedbackTriggerProps} />
        <main id="main">
          <section className="view empty-state">
            <h1 className="display">Loading trails…</h1>
          </section>
        </main>
      </>
    )
  } else if (mode === "hub-error") {
    shell = (
      <>
        <Topbar mode="minimal" {...feedbackTriggerProps} />
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
  } else if (mode === "welcome") {
    shell = (
      <>
        <Topbar mode="minimal" {...feedbackTriggerProps} />
        <main id="main">
          <WelcomeView hubUrl={data!.hubUrl} retry={retry} syncError={error} />
        </main>
      </>
    )
  } else {
    if (data === null) throw new Error("loaded shell requires a bootstrap snapshot")
    shell = (
      <LoadedApp
        bootstrap={data}
        mutations={mutations}
        syncError={error}
        retry={retry}
        onboarding={mode === "onboarding"}
        feedbackOpen={feedbackOpen}
        setFeedbackOpen={setFeedbackOpen}
        feedbackTriggerRef={feedbackTriggerRef}
        setFeedbackLocation={setFeedbackLocation}
      />
    )
  }

  return (
    <>
      {shell}
      <FeedbackPanel
        id={FEEDBACK_PANEL_ID}
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        fallbackFocusRef={feedbackTriggerRef}
        endpoint={FEEDBACK_ENDPOINT}
        contextInput={contextInput}
      />
    </>
  )
}
