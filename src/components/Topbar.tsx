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
  boundary: number
  setBoundary: (b: number) => void
  halo: number
  setHalo: (h: number) => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
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
    ["days", "Days"],
    ["week", "Week"],
    ["threads", "Threads"],
  ]

  return (
    <header className="topbar">
      <div className="wordmark">
        <span className="wordmark-name">trails</span>
        <span className="wordmark-sub">where your days actually went</span>
      </div>
      <nav className="tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={`tab${view === key ? " is-active" : ""}`} onClick={() => onView(key)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="controls" ref={controlsRef}>
        <button className="control-btn" onClick={onToggleSort}>
          Sort projects
        </button>
        <button className="control-btn" aria-label="settings" onClick={() => setSettingsOpen(!settingsOpen)}>
          settings
        </button>
        <div className="settings-pop" hidden={!settingsOpen}>
          <label className="control">
            <span>day starts</span>
            <select value={boundary} onChange={(e) => setBoundary(+e.target.value)}>
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
            <select value={halo} onChange={(e) => setHalo(+e.target.value)}>
              <option value={0}>none</option>
              <option value={5}>± 5 min</option>
              <option value={10}>± 10 min</option>
              <option value={15}>± 15 min</option>
            </select>
          </label>
        </div>
      </div>
    </header>
  )
}
