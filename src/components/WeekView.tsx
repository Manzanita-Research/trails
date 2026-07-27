import { engColor, fmtDur, focusMinutes, labelDate, shiftDate, type Engagement } from "../lib/data"
import { useTrails } from "../lib/ctx"

const credit = (mins: number): number => {
  const h = mins / 60
  if (h >= 5.5) return 1
  if (h >= 2.5) return 0.5
  if (h >= 1) return 0.25
  return 0
}
const creditLabel: Record<number, string> = { 1: "1", 0.5: "½", 0.25: "¼" }

export function WeekView() {
  const t = useTrails()

  // per calendar day: engagement → focus minutes
  const perDay = new Map<string, Map<string, { eng: Engagement; focus: number }>>()
  for (const [date, projMap] of t.days) {
    const byEng = new Map<string, { eng: Engagement; sets: Set<number>[] }>()
    for (const [project, data] of projMap) {
      const eng = t.engOf(project)
      if (!byEng.has(eng.id)) byEng.set(eng.id, { eng, sets: [] })
      byEng.get(eng.id)!.sets.push(data.user)
    }
    perDay.set(
      date,
      new Map([...byEng.entries()].map(([id, { eng, sets }]) => [id, { eng, focus: focusMinutes(sets, t.halo) }])),
    )
  }

  const weeks = new Map<string, string[]>()
  for (const [date] of t.days) {
    const d = new Date(`${date}T12:00:00Z`)
    const monday = shiftDate(date, -((d.getUTCDay() + 6) % 7))
    if (!weeks.has(monday)) weeks.set(monday, [])
    weeks.get(monday)!.push(date)
  }

  return (
    <section className="view">
      <p className="view-intro">
        Your attention-hours per engagement, rolled up the way you actually bill:{" "}
        <strong>roughly 3 hours is a half day, 6+ is a full day</strong>, and partial days can smash together across
        the week. Tune the attention halo in settings until these totals feel honest, then sort any misfiled projects.
      </p>
      {[...weeks.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([monday, weekDays]) => {
          const dates = Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
          const engById = new Map<string, Engagement>()
          for (const date of weekDays) for (const [id, { eng }] of perDay.get(date) ?? []) engById.set(id, eng)

          const rows = [...engById.values()]
            .map((eng) => {
              let weekMins = 0
              let weekCredits = 0
              const cells = dates.map((date) => {
                const f = perDay.get(date)?.get(eng.id)?.focus ?? 0
                weekMins += f
                const c = credit(f)
                weekCredits += c
                return { date, f, c }
              })
              return { eng, weekMins, weekCredits, cells }
            })
            .filter((r) => r.weekMins > 0)
            .sort((a, b) => b.weekMins - a.weekMins)

          return (
            <div key={monday} className="week-block">
              <h2 className="week-title">
                {labelDate(monday).label} – {labelDate(shiftDate(monday, 6)).label}
              </h2>
              <table className="week-table">
                <thead>
                  <tr>
                    <th>Engagement</th>
                    {dates.map((d) => (
                      <th key={d}>{labelDate(d).dow}</th>
                    ))}
                    <th>Days</th>
                    <th>Hours</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.eng.id}>
                      <td>
                        <span className="eng-cell">
                          <span className="dot" style={{ background: engColor(r.eng) }} />
                          {r.eng.name}
                        </span>
                      </td>
                      {r.cells.map(({ date, f, c }) => (
                        <td key={date}>
                          {f ? (
                            <>
                              <span className="cell-credit">{c ? creditLabel[c] : "·"}</span>
                              <span className="cell-hours">{fmtDur(f)}</span>
                            </>
                          ) : (
                            <span className="cell-empty">—</span>
                          )}
                        </td>
                      ))}
                      <td>
                        <span className="cell-credit">{r.weekCredits || "—"}</span>
                      </td>
                      <td>{fmtDur(r.weekMins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="credit-note">
                ¼ ≥ 1h · ½ ≥ 2.5h · full ≥ 5.5h of attention. Credits are a starting point for your invoice, not the
                invoice.
              </p>
            </div>
          )
        })}
    </section>
  )
}
