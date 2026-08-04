import { useState } from "react"
import { engColor, fmtAgo, type Session } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { Ticks } from "./SessLine"

interface Card {
  project: string
  latest: Session
  ageMin: number
  agentHadLastWord: boolean
}


function ThreadCard({ card, accent }: { card: Card; accent?: boolean }) {
  const t = useTrails()
  const note =
    card.ageMin >= 60 && card.ageMin < 60 * 36 && card.agentHadLastWord
      ? " · agent had the last word — output may be unseen"
      : ""
  const snip = t.sessSummary(card.latest.id) ?? card.latest.firstPrompt
  return (
    <div className="thread">
      <button className="thread-name" onClick={() => t.openProject(card.project)}>
        <span className="sq" style={{ background: engColor(t.engOf(card.project)) }} />
        {t.dispName(card.project)}
      </button>
      <div className={`thread-when${accent ? " is-you" : ""}`}>
        {fmtAgo(card.latest.end, t.nowTime)}
        {note}
      </div>
      {snip && (
        <div className="thread-snippet">
          <Ticks text={snip} />
        </div>
      )}
    </div>
  )
}

export function ThreadsView() {
  const t = useTrails()
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState<"add" | string | null>(null)

  const byProject = new Map<string, Session[]>()
  for (const s of t.sessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, [])
    byProject.get(s.project)!.push(s)
  }

  const cols: Record<string, Card[]> = { motion: [], waiting: [], resting: [], dormant: [] }
  for (const [project, sessions] of byProject) {
    const latest = sessions.reduce((a, b) => (a.end > b.end ? a : b))
    const ageMin = (t.nowTime - new Date(latest.end).getTime()) / 60000
    const lastBucket = latest.activity[latest.activity.length - 1]
    const card: Card = { project, latest, ageMin, agentHadLastWord: !!lastBucket && lastBucket[3] === 0 }
    if (ageMin < 60) cols.motion.push(card)
    else if (ageMin < 60 * 36) cols.waiting.push(card)
    else if (ageMin < 60 * 24 * 7) cols.resting.push(card)
    else cols.dormant.push(card)
  }
  for (const key of Object.keys(cols)) cols[key].sort((a, b) => a.ageMin - b.ageMin)

  const colDefs: [string, string, string][] = [
    ["motion", "in motion", "touched in the last hour"],
    ["waiting", "waiting on you", "finished or paused, last day or so"],
    ["resting", "resting", "quiet this week"],
    ["dormant", "dormant", "quiet longer — and that's fine"],
  ]

  const addPocket = async () => {
    const text = draft.trim()
    if (!text) return
    setSaving("add")
    try {
      await t.addPocket(text)
      setDraft("")
    } finally {
      setSaving(null)
    }
  }

  const deletePocket = async (id: string) => {
    setSaving(id)
    try {
      await t.deletePocket(id)
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="view">
      <div className="datebar">
        <h1 className="display">Threads</h1>
      </div>
      <div className="facts">in motion, waiting on you, or resting — and resting is a real state, not a failure state</div>
      <div className="threads-grid">
        {colDefs.map(([key, title, sub]) => {
          const cards = cols[key]
          const shown = cards.slice(0, 10)
          return (
            <div key={key} className="thread-col">
              <h2 className="thread-col-head">
                <b>
                  {title} <i>· {cards.length}</i>
                </b>
                <span>{sub}</span>
              </h2>
              {shown.map((c) => (
                <ThreadCard key={c.project} card={c} accent={key === "waiting"} />
              ))}
              {cards.length > shown.length && <div className="thread-more">+ {cards.length - shown.length} more</div>}
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
          onSubmit={(event) => {
            event.preventDefault()
            void addPocket()
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="the idea, before it evaporates"
            autoComplete="off"
            disabled={saving === "add"}
          />
          <button type="submit" disabled={saving === "add"}>catch</button>
        </form>
        <div>
          {t.pocket.map((item) => (
            <div key={item.id} className="pocket-item">
              <span className="when">
                {new Date(item.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
              <span className="text">{item.text}</span>
              <button
                className="del"
                aria-label="delete note"
                title="let it go"
                disabled={saving === item.id}
                onClick={() => void deletePocket(item.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
