import { useState } from "react"
import {
  engColor,
  fmtDur,
  focusMinutes,
  labelDate,
  type DayMap,
  type DayProject,
} from "../lib/data"
import { useTrails } from "../lib/ctx"
import { HourGrid, LaneMarks, makeX, useWidth } from "./timeline"
import { DayNote, SessLine } from "./SessLine"

function DayTimeline({ dayProjects, widthPx }: { dayProjects: DayMap; widthPx: number }) {
  const t = useTrails()
  const labelW = 190
  const plotW = Math.max(320, widthPx - labelW)
  const laneH = 16
  const laneGap = 6
  const topPad = 18
  const projects = [...dayProjects.entries()].sort((a, b) => Math.min(...a[1].all) - Math.min(...b[1].all))
  const H = topPad + projects.length * (laneH + laneGap) + 14
  const X = makeX(labelW, plotW, t.boundary)

  return (
    <svg className="day-svg" width={widthPx} height={H} viewBox={`0 0 ${widthPx} ${H}`} role="img" aria-label="activity timeline">
      <HourGrid X={X} topPad={topPad} H={H} boundary={t.boundary} />
      {projects.map(([project, data], i) => {
        const y = topPad + i * (laneH + laneGap)
        const name = t.dispName(project)
        return (
          <g key={project}>
            <text x={labelW - 10} y={y + laneH - 4} fill="var(--ink-2)" fontSize={11.5} textAnchor="end">
              {name.length > 24 ? name.slice(0, 23) + "…" : name}
            </text>
            <LaneMarks data={data} X={X} y={y} laneH={laneH} color={engColor(t.engOf(project))} project={project} />
          </g>
        )
      })}
    </svg>
  )
}

function ProjRow({
  date,
  project,
  data,
  focus,
  open,
  onToggle,
}: {
  date: string
  project: string
  data: DayProject
  focus: number
  open: boolean
  onToggle: () => void
}) {
  const t = useTrails()
  const eng = t.engOf(project)
  return (
    <div className="proj-row">
      <button className="proj-summary" onClick={onToggle}>
        <span className="dot" style={{ background: engColor(eng) }} />
        <span
          className="proj-name proj-link"
          onClick={(e) => {
            e.stopPropagation()
            t.openProject(project)
          }}
        >
          {t.dispName(project)}
        </span>
        <span className="proj-org">{eng.name}</span>
        <span className="proj-meta">
          <span>
            <b>{fmtDur(focus)}</b> you
          </span>
          <span className="quiet">{fmtDur(data.all.size)} agents</span>
          <span className="quiet">
            {data.sessions.size} session{data.sessions.size === 1 ? "" : "s"}
          </span>
        </span>
        <span className="proj-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="proj-detail">
          <DayNote date={date} project={project} />
          {[...data.sessions.entries()]
            .sort((a, b) => a[1].min - b[1].min)
            .map(([idx, span]) => (
              <SessLine key={idx} sess={t.sessions[idx]} span={span} />
            ))}
        </div>
      )}
    </div>
  )
}

function DayCard({ date, projMap, widthPx }: { date: string; projMap: DayMap; widthPx: number }) {
  const t = useTrails()
  const [openRows, setOpenRows] = useState<Set<string>>(new Set())
  const { dow, label } = labelDate(date)
  const focus = focusMinutes([...projMap.values()].map((p) => p.user), t.halo)
  const agentMin = new Set([...projMap.values()].flatMap((p) => [...p.all])).size
  const sessCount = new Set([...projMap.values()].flatMap((p) => [...p.sessions.keys()])).size

  const byEng = new Map<string, { name: string; color: string; sets: Set<number>[] }>()
  for (const [project, data] of projMap) {
    const eng = t.engOf(project)
    if (!byEng.has(eng.id)) byEng.set(eng.id, { name: eng.name, color: engColor(eng), sets: [] })
    byEng.get(eng.id)!.sets.push(data.user)
  }
  const chips = [...byEng.values()]
    .map((c) => ({ ...c, focus: focusMinutes(c.sets, t.halo) }))
    .filter((c) => c.focus > 0)
    .sort((a, b) => b.focus - a.focus)

  const rows = [...projMap.entries()]
    .map(([project, data]) => ({ project, data, focus: focusMinutes([data.user], t.halo) }))
    .sort((a, b) => b.focus - a.focus)

  return (
    <article className="day-card">
      <div className="day-head">
        <span className="day-date">{label}</span>
        <span className="day-dow">{dow}</span>
        <span className="day-stats">
          <span>
            <b>{fmtDur(focus)}</b> your attention
          </span>
          <span>
            <b>{fmtDur(agentMin)}</b> agents active
          </span>
          <span>
            <b>{sessCount}</b> sessions
          </span>
        </span>
      </div>
      <div className="day-engagements">
        {chips.map((c) => (
          <span key={c.name} className="eng-chip">
            <span className="dot" style={{ background: c.color }} />
            {c.name} <b>{fmtDur(c.focus)}</b>
          </span>
        ))}
      </div>
      <DayTimeline dayProjects={projMap} widthPx={widthPx} />
      <div className="proj-rows">
        {rows.map(({ project, data, focus: f }) => {
          const key = `${date}|${project}`
          return (
            <ProjRow
              key={key}
              date={date}
              project={project}
              data={data}
              focus={f}
              open={openRows.has(key)}
              onToggle={() => {
                const next = new Set(openRows)
                next.has(key) ? next.delete(key) : next.add(key)
                setOpenRows(next)
              }}
            />
          )
        })}
      </div>
    </article>
  )
}

export function DaysView() {
  const t = useTrails()
  const [ref, width] = useWidth<HTMLElement>()
  const widthPx = Math.min(1032, width) - 42
  return (
    <section ref={ref} className="view">
      <p className="view-intro">
        Days are shaped around your sleep, not midnight — work until {t.boundary - 1} am still belongs to the evening
        before. <strong>Solid marks are minutes you were actually there</strong>, prompting and steering. The pale wash
        is agents running while your attention was somewhere else.
      </p>
      {t.days.map(([date, projMap]) => (
        <DayCard key={date} date={date} projMap={projMap} widthPx={widthPx} />
      ))}
    </section>
  )
}
