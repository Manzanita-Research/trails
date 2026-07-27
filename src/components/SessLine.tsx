import { fmtClock, type Session } from "../lib/data"
import { useTrails } from "../lib/ctx"

export function SessLine({ sess, span }: { sess: Session; span: { min: number; max: number } }) {
  const t = useTrails()
  const sum = t.sessSummary(sess.id)
  const text = sum ?? sess.firstPrompt
  return (
    <div className="sess">
      <span className="sess-time">
        {fmtClock(span.min)} – {fmtClock(span.max)}
      </span>
      <span className="sess-src">{sess.source}</span>
      <span
        className={`sess-prompt${sum ? " is-summary" : ""}`}
        title={sum && sess.firstPrompt ? `opening prompt: ${sess.firstPrompt}` : undefined}
      >
        {text ?? <em>no prompt captured</em>}
      </span>
    </div>
  )
}

// per-project day rollup, shown when the summarizer has run
export function DayNote({ date, project }: { date: string; project: string }) {
  const t = useTrails()
  const sum = t.daySummary(date, project)
  return sum ? <p className="day-summary">{sum}</p> : null
}
