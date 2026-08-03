import { useState } from "react"
import { useTrails } from "../lib/ctx"

export function SortPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTrails()
  const [savingProject, setSavingProject] = useState<string | null>(null)

  // one row per project, busiest first
  const byProject = new Map<string, { org: string; userEvents: number }>()
  for (const s of t.sessions) {
    const cur = byProject.get(s.project)
    if (cur) cur.userEvents += s.userEvents
    else byProject.set(s.project, { org: s.org, userEvents: s.userEvents })
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1].userEvents - a[1].userEvents)

  const onChange = async (project: string, value: string) => {
    setSavingProject(project)
    try {
      if (value === "__new__") {
        const name = prompt("Name the engagement (a client, a practice, a life area):")?.trim()
        if (!name) return
        const engagementId = await t.addEngagement(name)
        await t.assign(project, engagementId)
      } else {
        await t.assign(project, value)
      }
    } finally {
      setSavingProject(null)
    }
  }

  return (
    <aside className="sort-panel" hidden={!open}>
      <div className="sort-head">
        <h2>Sort projects into engagements</h2>
        <button className="close-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <p className="sort-hint">
        Everything starts auto-sorted by repo org. Reassign anything that landed wrong — this feeds the Week billing
        view.
      </p>
      <div>
        {rows.map(([project, { org }]) => (
          <div key={project} className="sort-row">
            <div className="names">
              <button className="proj-link" onClick={() => t.openProject(project)}>
                {t.dispName(project)}
              </button>
              <span className="proj-org">{org}</span>
            </div>
            <select
              value={t.engOf(project).id}
              disabled={savingProject === project}
              onChange={(event) => void onChange(project, event.target.value)}
            >
              {t.engs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
              <option value="__new__">+ new engagement…</option>
            </select>
          </div>
        ))}
      </div>
    </aside>
  )
}
