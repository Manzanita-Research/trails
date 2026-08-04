import type { RefObject } from "react"
import { useTrails } from "../lib/ctx"
import { EngagementSelect } from "./EngagementSelect"
import { SidePanel } from "./SidePanel"

export interface SortPanelProps {
  id: string
  open: boolean
  onClose: () => void
  fallbackFocusRef?: RefObject<HTMLElement | null>
}

export function SortPanel({ id, open, onClose, fallbackFocusRef }: SortPanelProps) {
  const t = useTrails()

  // one row per project, busiest first
  const byProject = new Map<string, { org: string; userEvents: number }>()
  for (const session of t.sessions) {
    const current = byProject.get(session.project)
    if (current) current.userEvents += session.userEvents
    else byProject.set(session.project, { org: session.org, userEvents: session.userEvents })
  }
  const rows = [...byProject.entries()].sort((a, b) => b[1].userEvents - a[1].userEvents)

  return (
    <SidePanel
      id={id}
      title="Organize projects"
      open={open}
      onClose={onClose}
      fallbackFocusRef={fallbackFocusRef}
    >
      <p className="sort-hint">
        Trails starts with one engagement per repository organization. An engagement can be a client, a practice, or a
        life area; changing one updates week totals.
      </p>
      <div className="sort-rows">
        {rows.map(([project, { org }]) => (
          <div key={project} className="sort-row">
            <div className="names">
              <button
                type="button"
                className="proj-link"
                onClick={() => {
                  onClose()
                  t.openProject(project)
                }}
              >
                {t.dispName(project)}
              </button>
              <span className="proj-org">{org}</span>
            </div>
            <EngagementSelect project={project} label={`engagement for ${t.dispName(project)}`} />
          </div>
        ))}
      </div>
    </SidePanel>
  )
}
