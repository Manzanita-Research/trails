import { engColor, fmtDur, focusMinutes, fullDate } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { LaneMarks, makeX, TicksRow, useWidth } from "./timeline"
import { DayNote } from "./SessLine"

export function ProjectView({ project, onBack, backLabel }: { project: string; onBack: () => void; backLabel: string }) {
  const t = useTrails()
  const [ref, width] = useWidth<HTMLElement>()
  const widthPx = Math.min(1100, width)
  const eng = t.engOf(project)

  const projDays = t.days.filter(([, projMap]) => projMap.has(project))
  const totalFocus = focusMinutes(projDays.map(([, m]) => m.get(project)!.user), t.halo)
  const totalAgent = projDays.reduce((sum, [, m]) => sum + m.get(project)!.all.size, 0)
  const sessCount = new Set(projDays.flatMap(([, m]) => [...m.get(project)!.sessions.keys()])).size

  // strips share the week view's row grid, so the axis below lines up
  const stripW = Math.max(320, widthPx - 170 - 36)
  const X = makeX(0, stripW, t.boundary)

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
      <h1 className="display detail-title">
        <span className="swatch" style={{ background: engColor(eng) }} />
        {t.dispName(project)}
      </h1>
      <div className="detail-meta">
        <span className="detail-path">~/{project}</span>
        <div className="detail-tools">
          <button className="quiet-btn" onClick={onRename}>
            rename
          </button>
          <label className="detail-file">
            files under
            <select value={eng.id} onChange={(e) => onEngChange(e.target.value)}>
              {t.engs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
              <option value="__new__">+ new engagement…</option>
            </select>
          </label>
        </div>
      </div>
      <div className="facts">
        attention <b>{fmtDur(totalFocus)}</b>
        <span className="sep">·</span>
        agents <b>{fmtDur(totalAgent)}</b>
        <span className="sep">·</span>
        {sessCount} session{sessCount === 1 ? "" : "s"} over {projDays.length} day{projDays.length === 1 ? "" : "s"}
      </div>
      <div className="detail-days">
        {projDays.map(([date, projMap]) => {
          const data = projMap.get(project)!
          const f = focusMinutes([data.user], t.halo)
          return (
            <div key={date} className="detail-row">
              <div>
                <button className="wk-d" onClick={() => t.openDay(date)}>
                  {fullDate(date)}
                </button>
                <div className="wk-m">
                  you {fmtDur(f)} · agents {fmtDur(data.all.size)}
                </div>
              </div>
              <div>
                <DayNote date={date} project={project} />
                <svg
                  className="detail-strip"
                  width={stripW}
                  height={21}
                  viewBox={`0 0 ${stripW} 21`}
                  aria-hidden="true"
                >
                  <LaneMarks data={data} X={X} y={3} laneH={15} color={engColor(eng)} project={project} />
                </svg>
              </div>
            </div>
          )
        })}
      </div>
      <TicksRow boundary={t.boundary} />
    </section>
  )
}
