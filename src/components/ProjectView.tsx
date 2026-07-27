import { engColor, fmtDur, focusMinutes, labelDate } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { HourGrid, LaneMarks, makeX, useWidth } from "./timeline"
import { DayNote, SessLine } from "./SessLine"

export function ProjectView({ project, onBack, backLabel }: { project: string; onBack: () => void; backLabel: string }) {
  const t = useTrails()
  const [ref, width] = useWidth<HTMLElement>()
  const widthPx = Math.min(1032, width) - 42
  const eng = t.engOf(project)

  const projDays = t.days.filter(([, projMap]) => projMap.has(project))
  const totalFocus = focusMinutes(projDays.map(([, m]) => m.get(project)!.user), t.halo)
  const totalAgent = projDays.reduce((sum, [, m]) => sum + m.get(project)!.all.size, 0)
  const sessCount = new Set(projDays.flatMap(([, m]) => [...m.get(project)!.sessions.keys()])).size

  const labelW = 90
  const plotW = Math.max(320, widthPx - labelW - 32)
  const X = makeX(labelW, plotW, t.boundary)

  const onRename = () => {
    const next = prompt("Display name for this project (empty to reset):", t.dispName(project))
    if (next === null) return
    t.rename(project, next.trim() || null)
  }

  const onEngChange = (value: string) => {
    if (value === "__new__") {
      const name = prompt("Name the engagement (a client, a practice, a life area):")?.trim()
      if (!name) return
      t.assign(project, t.addEngagement(name))
    } else {
      t.assign(project, value)
    }
  }

  return (
    <section ref={ref} className="view">
      <button className="back-btn" onClick={onBack}>
        ← back to {backLabel}
      </button>
      <div className="detail-head">
        <span className="dot" style={{ background: engColor(eng) }} />
        <h1 className="detail-title">{t.dispName(project)}</h1>
        <button className="rename-btn" title="rename" onClick={onRename}>
          rename
        </button>
        <select value={eng.id} onChange={(e) => onEngChange(e.target.value)}>
          {t.engs.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
          <option value="__new__">+ new engagement…</option>
        </select>
      </div>
      <p className="detail-path">~/{project}</p>
      <div className="detail-stats">
        <span className="stat">
          <b>{fmtDur(totalFocus)}</b>
          <span>your attention</span>
        </span>
        <span className="stat">
          <b>{fmtDur(totalAgent)}</b>
          <span>agent minutes</span>
        </span>
        <span className="stat">
          <b>{sessCount}</b>
          <span>sessions</span>
        </span>
        <span className="stat">
          <b>{projDays.length}</b>
          <span>days touched</span>
        </span>
      </div>
      {projDays.map(([date, projMap]) => {
        const data = projMap.get(project)!
        const f = focusMinutes([data.user], t.halo)
        const { dow, label } = labelDate(date)
        const H = 30
        return (
          <div key={date} className="detail-day">
            <div className="detail-day-head">
              <span className="day-date">{label}</span>
              <span className="day-dow">{dow}</span>
              <span className="day-stats">
                <span>
                  <b>{fmtDur(f)}</b> you
                </span>
                <span>
                  <b>{fmtDur(data.all.size)}</b> agents
                </span>
              </span>
            </div>
            <DayNote date={date} project={project} />
            <svg className="day-svg" width={widthPx - 32} height={H} viewBox={`0 0 ${widthPx - 32} ${H}`}>
              <HourGrid X={X} topPad={10} H={H + 8} boundary={t.boundary} withLabels={false} />
              <LaneMarks data={data} X={X} y={7} laneH={16} color={engColor(eng)} project={project} />
            </svg>
            <div>
              {[...data.sessions.entries()]
                .sort((a, b) => a[1].min - b[1].min)
                .map(([idx, span]) => (
                  <SessLine key={idx} sess={t.sessions[idx]} span={span} />
                ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}
