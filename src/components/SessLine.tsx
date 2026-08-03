import type { ReactNode } from "react"
import { useTrails } from "../lib/ctx"

// summarizer prose carries `backticked` identifiers; set them in mono. Unmatched ticks stay literal.
export function Ticks({ text }: { text: string }) {
  const out: ReactNode[] = []
  const re = /`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(<code key={m.index}>{m[1]}</code>)
    last = m.index + m[0].length
  }
  if (last === 0) return <>{text}</>
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}

// per-project day rollup, shown when the summarizer has run
export function DayNote({ date, project }: { date: string; project: string }) {
  const t = useTrails()
  const sum = t.daySummary(date, project)
  return sum ? (
    <p className="day-summary">
      <Ticks text={sum} />
    </p>
  ) : null
}
