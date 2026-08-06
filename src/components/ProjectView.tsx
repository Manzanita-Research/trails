import { useEffect, useRef, useState, type FormEvent } from "react"
import { attentionMinutes, engColor, fmtDur, fullDate } from "../lib/data"
import { useTrails } from "../lib/ctx"
import { LaneMarks, makeX, TicksRow, useWidth } from "./timeline"
import { DayNote } from "./SessLine"
import { EngagementSelect } from "./EngagementSelect"

export function ProjectView({ project, onBack, backLabel }: { project: string; onBack: () => void; backLabel: string }) {
  const t = useTrails()
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")
  const [renameSaving, setRenameSaving] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameButtonRef = useRef<HTMLButtonElement>(null)
  const restoreRenameFocusRef = useRef(false)
  const [ref, width] = useWidth<HTMLElement>()
  const widthPx = Math.min(1100, width)
  const eng = t.engOf(project)

  const projDays = t.days.filter(([, projMap]) => projMap.has(project))
  const totalFocus = projDays.reduce((sum, [, projects]) => {
    const data = projects.get(project)!
    return sum + attentionMinutes([data.user], [data.granola, data.midjourney], t.halo)
  }, 0)
  const totalAgent = projDays.reduce((sum, [, m]) => sum + m.get(project)!.all.size, 0)
  const sessCount = new Set(projDays.flatMap(([, m]) => [...m.get(project)!.sessions.keys()])).size

  // strips share the week view's row grid, so the axis below lines up
  const stripW = Math.max(320, widthPx - 170 - 36)
  const X = makeX(0, stripW, t.boundary)

  useEffect(() => {
    if (renaming && !renameSaving) renameInputRef.current?.focus()
  }, [renameError, renameSaving, renaming])

  useEffect(() => {
    if (!renaming && restoreRenameFocusRef.current) {
      restoreRenameFocusRef.current = false
      renameButtonRef.current?.focus()
    }
  }, [renaming])

  const beginRename = () => {
    setRenameDraft(t.dispName(project))
    setRenameError(null)
    setRenaming(true)
  }

  const cancelRename = () => {
    if (renameSaving) return
    restoreRenameFocusRef.current = true
    setRenaming(false)
    setRenameDraft("")
    setRenameError(null)
  }

  const saveRename = async (event: FormEvent) => {
    event.preventDefault()
    setRenameSaving(true)
    setRenameError(null)
    try {
      await t.rename(project, renameDraft.trim() || null)
      restoreRenameFocusRef.current = true
      setRenaming(false)
      setRenameDraft("")
    } catch {
      setRenameError("Couldn’t rename this project. Try again.")
    } finally {
      setRenameSaving(false)
    }
  }

  return (
    <section ref={ref} className="view">
      <button type="button" className="back-btn" onClick={onBack}>
        ← back to {backLabel}
      </button>
      <h1 className="display detail-title">
        <span className="swatch" style={{ background: engColor(eng) }} />
        {t.dispName(project)}
      </h1>
      <div className="detail-meta">
        <span className="detail-path">~/{project}</span>
        <div className="detail-tools">
          {renaming ? (
            <form
              className="rename-editor"
              onSubmit={(event) => void saveRename(event)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !renameSaving) {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelRename()
                }
              }}
            >
              <label>
                project name
                <input
                  ref={renameInputRef}
                  type="text"
                  value={renameDraft}
                  maxLength={80}
                  disabled={renameSaving}
                  onChange={(event) => {
                    setRenameDraft(event.target.value)
                    setRenameError(null)
                  }}
                />
              </label>
              <div className="rename-editor-actions">
                <button type="submit" disabled={renameSaving}>
                  {renameSaving ? "saving…" : "save"}
                </button>
                <button type="button" disabled={renameSaving} onClick={cancelRename}>
                  cancel
                </button>
              </div>
              {renameError ? <p role="alert">{renameError}</p> : null}
            </form>
          ) : (
            <button ref={renameButtonRef} type="button" className="quiet-btn" onClick={beginRename}>
              rename
            </button>
          )}
          <EngagementSelect project={project} label="engagement" showLabel className="detail-file" />
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
          const f = attentionMinutes([data.user], [data.granola, data.midjourney], t.halo)
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
