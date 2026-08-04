import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import { useTrails } from "../lib/ctx"

export interface EngagementSelectProps {
  project: string
  label: string
  showLabel?: boolean
  className?: string
}

export function EngagementSelect({ project, label, showLabel = false, className }: EngagementSelectProps) {
  const t = useTrails()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdEngagementId, setCreatedEngagementId] = useState<string | null>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const restoreSelectFocusRef = useRef(false)
  const controlId = useId()
  const classes = ["engagement-select", className].filter(Boolean).join(" ")

  useEffect(() => {
    if (editing && !saving) inputRef.current?.focus()
  }, [editing, error, saving])

  useEffect(() => {
    if (!editing && restoreSelectFocusRef.current) {
      restoreSelectFocusRef.current = false
      selectRef.current?.focus()
    }
  }, [editing])

  const cancelEditor = () => {
    if (saving) return
    restoreSelectFocusRef.current = true
    setEditing(false)
    setDraft("")
    setError(null)
    setCreatedEngagementId(null)
  }

  const assign = async (engagementId: string) => {
    setSaving(true)
    setError(null)
    try {
      await t.assign(project, engagementId)
    } catch {
      setError("Couldn’t save that engagement. Try again.")
    } finally {
      setSaving(false)
    }
  }

  const saveNew = async (event: FormEvent) => {
    event.preventDefault()
    const name = draft.trim()
    if (!name) {
      setError("Enter an engagement name.")
      return
    }

    setSaving(true)
    setError(null)
    try {
      let engagementId = createdEngagementId
      if (!engagementId) {
        engagementId = await t.addEngagement(name)
        setCreatedEngagementId(engagementId)
      }
      await t.assign(project, engagementId)
      setEditing(false)
      setDraft("")
      setCreatedEngagementId(null)
    } catch {
      setError("Couldn’t save that engagement. Try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={classes}
      onKeyDown={(event) => {
        if (event.key === "Escape" && editing && !saving) {
          event.preventDefault()
          event.stopPropagation()
          cancelEditor()
        }
      }}
    >
      {showLabel ? (
        <label className="engagement-select-label" htmlFor={controlId}>
          {label}
        </label>
      ) : null}
      {editing ? (
        <form className="engagement-editor" onSubmit={(event) => void saveNew(event)}>
          <input
            ref={inputRef}
            id={controlId}
            type="text"
            value={draft}
            maxLength={80}
            disabled={saving}
            aria-label={showLabel ? undefined : label}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
              setCreatedEngagementId(null)
            }}
          />
          <div className="engagement-editor-actions">
            <button type="submit" disabled={saving}>
              {saving ? "saving…" : "save"}
            </button>
            <button type="button" disabled={saving} onClick={cancelEditor}>
              cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <select
            ref={selectRef}
            id={controlId}
            value={t.engOf(project).id}
            disabled={saving}
            aria-label={showLabel ? undefined : label}
            onChange={(event) => {
              const value = event.target.value
              if (value === "__new__") {
                setDraft("")
                setError(null)
                setCreatedEngagementId(null)
                setEditing(true)
              } else {
                void assign(value)
              }
            }}
          >
            {t.engs.map((engagement) => (
              <option key={engagement.id} value={engagement.id}>
                {engagement.name}
              </option>
            ))}
            <option value="__new__">+ new engagement…</option>
          </select>
          {saving ? <span className="engagement-saving">saving…</span> : null}
        </>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  )
}
