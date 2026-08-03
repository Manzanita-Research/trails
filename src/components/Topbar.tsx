import { useEffect, useRef, useState } from "react"

export type ListView = "days" | "week" | "threads"

export function Topbar({
  view,
  onView,
  onToggleSort,
  boundary,
  setBoundary,
  halo,
  setHalo,
}: {
  view: string
  onView: (v: ListView) => void
  onToggleSort: () => void
  boundary: 4 | 5 | 6 | 7
  setBoundary: (boundary: 4 | 5 | 6 | 7) => Promise<void>
  halo: 0 | 5 | 10 | 15
  setHalo: (halo: 0 | 5 | 10 | 15) => Promise<void>
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState<"boundary" | "halo" | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const onDown = (e: MouseEvent) => {
      if (!controlsRef.current?.contains(e.target as Node)) setSettingsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [settingsOpen])

  const tabs: [ListView, string][] = [
    ["days", "days"],
    ["week", "week"],
    ["threads", "threads"],
  ]

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="wordmark">trails</span>
        <nav className="nav" aria-label="views">
          {tabs.map(([key, label]) => (
            <button key={key} className={`nav-link${view === key ? " is-on" : ""}`} onClick={() => onView(key)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="controls" ref={controlsRef}>
          <button className="quiet-btn" onClick={onToggleSort}>
            sort projects
          </button>
          <button className="quiet-btn" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}>
            settings
          </button>
          <div className="settings-pop" hidden={!settingsOpen}>
            <label className="control">
              <span>day starts</span>
              <select
                value={boundary}
                disabled={saving === "boundary"}
                onChange={async (event) => {
                  setSaving("boundary")
                  try {
                    await setBoundary(Number(event.target.value) as 4 | 5 | 6 | 7)
                  } finally {
                    setSaving(null)
                  }
                }}
              >
                <option value={4}>4 am</option>
                <option value={5}>5 am</option>
                <option value={6}>6 am</option>
                <option value={7}>7 am</option>
              </select>
            </label>
            <label
              className="control"
              title="Minutes of presence credited around each prompt you typed — reading, reviewing, thinking. Tune it until day totals feel honest."
            >
              <span>attention halo</span>
              <select
                value={halo}
                disabled={saving === "halo"}
                onChange={async (event) => {
                  setSaving("halo")
                  try {
                    await setHalo(Number(event.target.value) as 0 | 5 | 10 | 15)
                  } finally {
                    setSaving(null)
                  }
                }}
              >
                <option value={0}>none</option>
                <option value={5}>± 5 min</option>
                <option value={10}>± 10 min</option>
                <option value={15}>± 15 min</option>
              </select>
            </label>
          </div>
        </div>
      </div>
    </header>
  )
}
