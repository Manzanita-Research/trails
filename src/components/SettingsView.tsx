import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  BootstrapV1,
  CollectorErrorCode,
  MachinesV1,
  SummarizationStatusV1,
} from "../../shared/protocol"
import { fetchMachines, fetchSummarization, type BootstrapMutations } from "../lib/api"
import { fmtAgo } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { EngagementSelect } from "./EngagementSelect"

type SettingField = "boundary" | "halo" | "timezone"
type EntryTarget = "top" | "projects"

const settingError = "That setting didn’t save. Try again."
const collectorErrors: Record<CollectorErrorCode, string> = {
  parse_error: "couldn’t read one or more session files",
  file_changed_during_read: "a session file changed while Trails read it",
  upload_error: "couldn’t send processed sessions to the hub",
  collector_error: "collector run failed",
}

function timezoneGroups(current: string): {
  readonly ungrouped: string[]
  readonly grouped: Array<readonly [string, string[]]>
} {
  const supported =
    "supportedValuesOf" in Intl
      ? Intl.supportedValuesOf("timeZone")
      : []
  const values = [...new Set([...supported, current, "UTC"])].sort((a, b) => a.localeCompare(b))
  const ungrouped: string[] = []
  const groups = new Map<string, string[]>()
  for (const value of values) {
    const separator = value.indexOf("/")
    if (separator < 0) {
      ungrouped.push(value)
      continue
    }
    const region = value.slice(0, separator)
    const names = groups.get(region) ?? []
    names.push(value)
    groups.set(region, names)
  }
  return {
    ungrouped,
    grouped: [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)),
  }
}

function TimezoneOptions({ current }: { readonly current: string }) {
  const groups = useMemo(() => timezoneGroups(current), [current])
  return (
    <>
      {groups.ungrouped.map((zone) => (
        <option key={zone} value={zone}>{zone}</option>
      ))}
      {groups.grouped.map(([region, zones]) => (
        <optgroup key={region} label={region}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.slice(region.length + 1).replaceAll("_", " ")}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  )
}

function freshness(timestamp: string | null, generatedAt: number, present: string, absent: string): string {
  return timestamp === null ? absent : `${present} ${fmtAgo(timestamp, generatedAt)}`
}

export interface SettingsViewProps {
  readonly bootstrap: BootstrapV1
  readonly mutations: BootstrapMutations
  readonly entryTarget: EntryTarget
  readonly onBack: () => void
  readonly onTimezoneSaved: () => void
}

export function SettingsView({
  bootstrap,
  mutations,
  entryTarget,
  onBack,
  onTimezoneSaved,
}: SettingsViewProps) {
  const t = useTrails()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const projectsRef = useRef<HTMLHeadingElement>(null)
  const [pending, setPending] = useState<Partial<Record<SettingField, boolean>>>({})
  const [errors, setErrors] = useState<Partial<Record<SettingField, boolean>>>({})
  const [machines, setMachines] = useState<MachinesV1 | null>(null)
  const [machinesLoading, setMachinesLoading] = useState(true)
  const [machinesError, setMachinesError] = useState(false)
  const [summarization, setSummarization] = useState<SummarizationStatusV1 | null>(null)
  const [summarizationLoading, setSummarizationLoading] = useState(true)
  const [summarizationError, setSummarizationError] = useState(false)

  useEffect(() => {
    const target = entryTarget === "projects" ? projectsRef.current : headingRef.current
    target?.focus()
    if (entryTarget === "projects") target?.scrollIntoView({ block: "start" })
    else scrollTo({ top: 0 })
  }, [entryTarget])

  const loadMachines = useCallback(async (showLoading = true) => {
    if (showLoading) setMachinesLoading(true)
    setMachinesError(false)
    try {
      setMachines(await fetchMachines())
    } catch {
      setMachinesError(true)
    } finally {
      if (showLoading) setMachinesLoading(false)
    }
  }, [])

  const loadSummarization = useCallback(async () => {
    setSummarizationLoading(true)
    setSummarizationError(false)
    try {
      setSummarization(await fetchSummarization())
    } catch {
      setSummarizationError(true)
    } finally {
      setSummarizationLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadMachines()
    void loadSummarization()
    const timer = window.setInterval(() => void loadMachines(false), 30_000)
    return () => window.clearInterval(timer)
  }, [loadMachines, loadSummarization])

  const save = async (
    field: SettingField,
    patch: Parameters<BootstrapMutations["updateSettings"]>[0],
  ) => {
    setPending((current) => ({ ...current, [field]: true }))
    setErrors((current) => ({ ...current, [field]: false }))
    try {
      await mutations.updateSettings(patch)
      if (field === "timezone") onTimezoneSaved()
    } catch {
      setErrors((current) => ({ ...current, [field]: true }))
    } finally {
      setPending((current) => ({ ...current, [field]: false }))
    }
  }

  const byProject = new Map<string, { org: string; userEvents: number }>()
  for (const session of t.sessions) {
    const current = byProject.get(session.project)
    if (current) current.userEvents += session.userEvents
    else byProject.set(session.project, { org: session.org, userEvents: session.userEvents })
  }
  const projects = [...byProject.entries()].sort(
    (left, right) => right[1].userEvents - left[1].userEvents || left[0].localeCompare(right[0]),
  )
  const generatedAt = machines === null ? 0 : new Date(machines.generatedAt).getTime()

  return (
    <section className="view settings-view" aria-labelledby="settings-heading">
      <button className="back-btn" onClick={onBack}>← back</button>
      <h1 ref={headingRef} id="settings-heading" className="display" tabIndex={-1}>settings</h1>

      <section className="settings-section" aria-labelledby="time-attention-heading">
        <h2 id="time-attention-heading">time &amp; attention</h2>
        <div className="settings-content settings-controls">
          <div className="settings-control-row">
            <label htmlFor="settings-boundary">day starts</label>
            <select
              id="settings-boundary"
              value={bootstrap.preferences.boundary}
              disabled={pending.boundary}
              onChange={(event) => void save("boundary", { boundary: Number(event.target.value) as 4 | 5 | 6 | 7 })}
            >
              <option value={4}>4 am</option>
              <option value={5}>5 am</option>
              <option value={6}>6 am</option>
              <option value={7}>7 am</option>
            </select>
            {errors.boundary && <p role="alert" className="settings-field-error">{settingError}</p>}
          </div>
          <div className="settings-control-row">
            <span className="settings-control-copy">
              <label htmlFor="settings-halo">attention halo</label>
              <span id="settings-halo-help" className="settings-help">
                nearby reading, reviewing, and thinking time counted around your prompts
              </span>
            </span>
            <select
              id="settings-halo"
              aria-describedby="settings-halo-help"
              value={bootstrap.preferences.halo}
              disabled={pending.halo}
              onChange={(event) => void save("halo", { halo: Number(event.target.value) as 0 | 5 | 10 | 15 })}
            >
              <option value={0}>none</option>
              <option value={5}>± 5 min</option>
              <option value={10}>± 10 min</option>
              <option value={15}>± 15 min</option>
            </select>
            {errors.halo && <p role="alert" className="settings-field-error">{settingError}</p>}
          </div>
          <div className="settings-control-row">
            <span className="settings-control-copy">
              <label htmlFor="settings-timezone">time zone</label>
              <span id="settings-timezone-help" className="settings-help">
                used for day boundaries and displayed times
              </span>
            </span>
            <select
              id="settings-timezone"
              aria-describedby="settings-timezone-help"
              value={bootstrap.timezone}
              disabled={pending.timezone}
              onChange={(event) => void save("timezone", { timezone: event.target.value })}
            >
              <TimezoneOptions current={bootstrap.timezone} />
            </select>
            {errors.timezone && <p role="alert" className="settings-field-error">{settingError}</p>}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="projects-heading">
        <h2 ref={projectsRef} id="projects-heading" tabIndex={-1}>projects</h2>
        <div className="settings-content">
          <p className="settings-hint">
            Trails starts with one engagement per repository organization. An engagement can be a client, a practice, or a life area; changing one updates week totals.
          </p>
          <div className="settings-projects">
            {projects.map(([project, { org }]) => (
              <div key={project} className="settings-project-row">
                <div className="settings-project-names">
                  <button type="button" className="proj-link" onClick={() => t.openProject(project)}>
                    {t.dispName(project)}
                  </button>
                  <span className="proj-org">{org}</span>
                </div>
                <EngagementSelect project={project} label={`engagement for ${t.dispName(project)}`} />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="machines-heading">
        <h2 id="machines-heading">machines</h2>
        <div className="settings-content machine-topology">
          <div className="machine-row machine-hub-row">
            <span className="machine-role">hub</span>
            <code>{bootstrap.hubUrl}</code>
          </div>
          <div className="machine-collectors">
            <h3>collectors</h3>
            {machinesLoading ? (
              <p>Reading machine status…</p>
            ) : machinesError ? (
              <p className="settings-load-error">
                Machine status couldn’t load. <button className="text-action" onClick={() => void loadMachines()}>try again</button>
              </p>
            ) : machines?.machines.length === 0 ? (
              <p>No collectors have checked in yet.</p>
            ) : (
              machines?.machines.map((machine) => (
                <div key={machine.id} className="machine-row collector-row">
                  <div className="machine-name">
                    <strong>{machine.name}</strong>
                    <code>{machine.id}</code>
                  </div>
                  <div className="machine-details">
                    <p>{freshness(machine.lastCheckedAt, generatedAt, "checked", "not checked yet")}</p>
                    <p>{freshness(machine.lastProcessedAt, generatedAt, "processed", "not processed yet")}</p>
                    <p>{freshness(machine.lastIngestedAt, generatedAt, "activity sent", "no activity sent")}</p>
                    {machine.metrics && (
                      <p>{machine.metrics.discovered} found · {machine.metrics.changed} changed · {machine.metrics.uploaded} sent · {machine.metrics.ignored} ignored · {machine.metrics.unchanged} unchanged</p>
                    )}
                    {machine.lastError && <p className="machine-error">{collectorErrors[machine.lastError]}</p>}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="summarization-heading">
        <h2 id="summarization-heading">summarization</h2>
        <div className="settings-content summarization-content">
          {summarizationLoading ? (
            <p>Reading summarization configuration…</p>
          ) : summarizationError ? (
            <p className="settings-load-error">
              Summarization details couldn’t load. <button className="text-action" onClick={() => void loadSummarization()}>try again</button>
            </p>
          ) : summarization?.enabled === false ? (
            <p>Summarization is off on this hub.</p>
          ) : summarization?.enabled === true ? (
            <dl className="summarization-values">
              <div>
                <dt>model for new summaries</dt>
                <dd><code>{summarization.metadata.model}</code></dd>
              </div>
              <div>
                <dt>session prompt</dt>
                <dd><pre>{summarization.metadata.prompts.session}</pre></dd>
              </div>
              <div>
                <dt>day prompt</dt>
                <dd><pre>{summarization.metadata.prompts.day}</pre></dd>
              </div>
              <div>
                <dt className="sr-only">one-session behavior</dt>
                <dd>A one-session day summary may be copied without a second model call.</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </section>
    </section>
  )
}
