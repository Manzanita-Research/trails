import {
  credit,
  engColor,
  fmtCredits,
  fmtDur,
  focusMinutes,
  fullDate,
  labelDate,
  runsOf,
  shiftDate,
  workdayToday,
  type DayMap,
  type Engagement,
} from "../lib/data"
import { useTrails } from "../lib/ctx"
import { TicksRow, useWidth } from "./timeline"
import { ActivityKey } from "./ActivityKey"

const STRIP_H = 34
const BAR_H = 5

// pack project intervals into at most three lanes, first-fit by start
function packLanes(projects: [string, { min: number; max: number }][]): Map<string, number> {
  const sorted = [...projects].sort((a, b) => a[1].min - b[1].min)
  const laneEnds: number[] = []
  const out = new Map<string, number>()
  for (const [project, { min, max }] of sorted) {
    let lane = laneEnds.findIndex((end) => end < min)
    if (lane === -1 && laneEnds.length < 3) lane = laneEnds.length
    if (lane === -1) lane = laneEnds.indexOf(Math.min(...laneEnds))
    laneEnds[lane] = Math.max(laneEnds[lane] ?? 0, max)
    out.set(project, lane)
  }
  return out
}

const laneYs = (count: number): number[] =>
  count <= 1 ? [15] : count === 2 ? [8, 21] : [3, 14.5, 26]

function WeekStrip({ projMap, widthPx }: { projMap: DayMap; widthPx: number }) {
  const t = useTrails()
  const B = t.boundary * 60
  const X = (min: number) => ((min - B) / 1440) * widthPx
  const spans: [string, { min: number; max: number }][] = [...projMap.entries()].map(([p, d]) => {
    const all = [...d.all]
    return [p, { min: Math.min(...all), max: Math.max(...all) }]
  })
  const lanes = packLanes(spans)
  const laneCount = Math.max(...[...lanes.values()]) + 1
  const ys = laneYs(laneCount)

  return (
    <svg className="wk-strip" width={widthPx} height={STRIP_H} viewBox={`0 0 ${widthPx} ${STRIP_H}`} aria-hidden="true">
      {[...projMap.entries()].map(([project, data]) => {
        const y = ys[lanes.get(project) ?? 0]
        const color = engColor(t.engOf(project))
        return (
          <g key={project}>
            {runsOf(data.all).map(([a, b]) => (
              <rect key={`a${a}`} x={X(a)} y={y} width={Math.max(1.5, X(b + 1) - X(a))} height={BAR_H} fill={color} opacity={0.22} />
            ))}
            {runsOf(data.user).map(([a, b]) => (
              <rect key={`u${a}`} x={X(a)} y={y} width={Math.max(2, X(b + 1) - X(a))} height={BAR_H} fill={color} />
            ))}
          </g>
        )
      })}
    </svg>
  )
}

export function WeekView() {
  const t = useTrails()
  const [ref, width] = useWidth<HTMLElement>()
  const today = workdayToday(t.boundary)
  const dayLookup = new Map(t.days)

  const weeks = new Map<string, string[]>()
  for (const [date] of t.days) {
    const d = new Date(`${date}T12:00:00Z`)
    const monday = shiftDate(date, -((d.getUTCDay() + 6) % 7))
    if (!weeks.has(monday)) weeks.set(monday, [])
    weeks.get(monday)!.push(date)
  }

  const stripW = Math.max(320, Math.min(1100, width) - 170 - 36)
  const engById = new Map<string, Engagement>()

  const blocks = [...weeks.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((monday) => {
      const dates = Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
      const dayRows = dates.map((date) => {
        const projMap = dayLookup.get(date)
        const focus = projMap ? focusMinutes([...projMap.values()].map((p) => p.user), t.halo) : 0
        const agent = projMap ? new Set([...projMap.values()].flatMap((p) => [...p.all])).size : 0
        return { date, projMap, focus, agent, credit: credit(focus) }
      })
      const weekFocus = dayRows.reduce((sum, r) => sum + r.focus, 0)
      const weekAgent = dayRows.reduce((sum, r) => sum + r.agent, 0)
      const counts = { 1: 0, 0.5: 0, 0.25: 0 } as Record<number, number>
      for (const r of dayRows) if (r.credit && r.date !== today) counts[r.credit]++

      // per-engagement rollup: credits and hours across the week
      const perEng = new Map<string, { eng: Engagement; mins: number; credits: number }>()
      for (const { projMap } of dayRows) {
        if (!projMap) continue
        const byEng = new Map<string, { eng: Engagement; sets: Set<number>[] }>()
        for (const [project, data] of projMap) {
          const eng = t.engOf(project)
          engById.set(eng.id, eng)
          if (!byEng.has(eng.id)) byEng.set(eng.id, { eng, sets: [] })
          byEng.get(eng.id)!.sets.push(data.user)
        }
        for (const [id, { eng, sets }] of byEng) {
          const f = focusMinutes(sets, t.halo)
          const cur = perEng.get(id) ?? { eng, mins: 0, credits: 0 }
          cur.mins += f
          cur.credits += credit(f)
          perEng.set(id, cur)
        }
      }
      const engRows = [...perEng.values()].filter((r) => r.mins > 0).sort((a, b) => b.mins - a.mins)

      return { monday, dayRows, weekFocus, weekAgent, counts, engRows }
    })

  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

  return (
    <section ref={ref} className="view">
      {blocks.map(({ monday, dayRows, weekFocus, weekAgent, counts, engRows }) => {
        const parts = [
          counts[1] ? plural(counts[1], "full day") : "",
          counts[0.5] ? plural(counts[0.5], "half") : "",
          counts[0.25] ? plural(counts[0.25], "quarter") : "",
        ].filter(Boolean)
        return (
          <div key={monday} className="week-block">
            <h1 className="display">Week of {fullDate(monday).split(", ")[1]}</h1>
            <div className="facts">
              attention <b>{fmtDur(weekFocus)}</b>
              <span className="sep">·</span>
              agents <b>{fmtDur(weekAgent)}</b>
              {parts.length > 0 && (
                <>
                  <span className="sep">·</span>
                  {parts.join(", ")}
                </>
              )}
            </div>
            <div className="wk-rows">
              {dayRows.map(({ date, projMap, focus, credit: c }) => {
                const { dow, label } = labelDate(date)
                const dayNum = label.split(" ")[1]
                const dowFull = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[dow]
                const isToday = date === today
                const meta = !projMap
                  ? date > today
                    ? ""
                    : "—"
                  : isToday
                    ? `so far ${fmtDur(focus)}`
                    : `${fmtDur(focus)}${c ? ` · ${{ 1: "full", 0.5: "half", 0.25: "quarter" }[c]}` : ""}`
                return (
                  <div key={date} className="wk-row">
                    <div>
                      <button className="wk-d" disabled={!projMap} onClick={() => projMap && t.openDay(date)}>
                        {dowFull} {dayNum}
                      </button>
                      {meta && <div className="wk-m">{meta}</div>}
                    </div>
                    {projMap ? <WeekStrip projMap={projMap} widthPx={stripW} /> : <span />}
                  </div>
                )
              })}
            </div>
            <TicksRow boundary={t.boundary} />
            {engRows.length > 0 && (
              <div className="wk-engs">
                {engRows.map(({ eng, mins, credits }) => (
                  <div key={eng.id} className="wk-eng">
                    <span className="swatch" style={{ background: engColor(eng) }} />
                    <span className="name">{eng.name}</span>
                    <span className="tally">
                      {credits ? `${fmtCredits(credits)} day${credits > 1 ? "s" : ""} · ` : ""}
                      {fmtDur(mins)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}

      <div className="legend">
        {[...engById.values()]
          .filter((e) => e.slot)
          .map((eng) => (
            <div key={eng.id} className="k">
              <span className="swatch" style={{ background: engColor(eng) }} /> {eng.name}
            </div>
          ))}
        <ActivityKey />
      </div>
      <p className="credit-note">
        ¼ ≥ 1 h · ½ ≥ 2.5 h · full ≥ 5.5 h of attention. Credits are a starting point for your invoice, not the invoice.
      </p>
    </section>
  )
}
