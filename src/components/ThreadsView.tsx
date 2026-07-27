import { useState } from "react"
import { engColor, fmtAgo, type Session } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { useStored } from "../lib/store"

interface Card {
  project: string
  latest: Session
  ageMin: number
  agentHadLastWord: boolean
}

interface PocketItem {
  text: string
  at: number
}

function ThreadCard({ card }: { card: Card }) {
  const t = useTrails()
  const note =
    card.ageMin >= 60 && card.ageMin < 60 * 36 && card.agentHadLastWord
      ? " · agent had the last word — output may be unseen"
      : ""
  const snip = t.sessSummary(card.latest.id) ?? card.latest.firstPrompt
  return (
    <div className="thread-card">
      <span className="proj-name proj-link" onClick={() => t.openProject(card.project)}>
        <span className="dot" style={{ background: engColor(t.engOf(card.project)) }} />
        {t.dispName(card.project)}
      </span>
      <div className="thread-when">
        {fmtAgo(card.latest.end, t.scanTime)}
        {note}
      </div>
      {snip && <div className="thread-snippet">{snip}</div>}
    </div>
  )
}

export function ThreadsView() {
  const t = useTrails()
  const [pocket, setPocket] = useStored<PocketItem[]>("pocket", [])
  const [draft, setDraft] = useState("")

  const byProject = new Map<string, Session[]>()
  for (const s of t.sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, [])
    byProject.get(s.project)!.push(s)
  }

  const cols: Record<string, Card[]> = { motion: [], waiting: [], resting: [], dormant: [] }
  for (const [project, sessions] of byProject) {
    const latest = sessions.reduce((a, b) => (a.end > b.end ? a : b))
    const ageMin = (t.scanTime - new Date(latest.end).getTime()) / 60000
    const lastBucket = latest.activity[latest.activity.length - 1]
    const card: Card = { project, latest, ageMin, agentHadLastWord: !!lastBucket && lastBucket[3] === 0 }
    if (ageMin < 60) cols.motion.push(card)
    else if (ageMin < 60 * 36) cols.waiting.push(card)
    else if (ageMin < 60 * 24 * 7) cols.resting.push(card)
    else cols.dormant.push(card)
  }
  for (const key of Object.keys(cols)) cols[key].sort((a, b) => a.ageMin - b.ageMin)

  const colDefs: [string, string, string][] = [
    ["motion", "In motion", "touched in the last hour"],
    ["waiting", "Waiting on you", "finished or paused, last day or so"],
    ["resting", "Resting", "quiet this week"],
    ["dormant", "Dormant", "quiet longer — and that's fine"],
  ]

  return (
    <section className="view">
      <p className="view-intro">
        Threads don't have deadlines or priority scores. They're <strong>in motion, waiting on you, or resting</strong>{" "}
        — and resting is a real state, not a failure state. Snapshot as of the last scan.
      </p>
      <div className="threads-grid">
        {colDefs.map(([key, title, sub]) => {
          const cards = cols[key]
          const shown = cards.slice(0, 10)
          return (
            <div key={key}>
              <h2 className="thread-col-head">
                <b>
                  {title} · {cards.length}
                </b>
                <span>{sub}</span>
              </h2>
              {shown.map((c) => (
                <ThreadCard key={c.project} card={c} />
              ))}
              {cards.length > shown.length && (
                <div className="thread-when" style={{ padding: "4px 2px" }}>
                  + {cards.length - shown.length} more
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="pocket">
        <h2>Divergence pocket</h2>
        <p className="pocket-hint">
          Mid-thread idea? Catch it here without abandoning what you're doing. It'll be waiting when you surface.
        </p>
        <form
          className="pocket-form"
          onSubmit={(e) => {
            e.preventDefault()
            const text = draft.trim()
            if (!text) return
            setPocket([{ text, at: Date.now() }, ...pocket])
            setDraft("")
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="the idea, before it evaporates"
            autoComplete="off"
          />
          <button type="submit">catch</button>
        </form>
        <div>
          {pocket.map((item, i) => (
            <div key={item.at} className="pocket-item">
              <span className="when">
                {new Date(item.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <span>{item.text}</span>
              <button className="del" title="let it go" onClick={() => setPocket(pocket.filter((_, j) => j !== i))}>
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
