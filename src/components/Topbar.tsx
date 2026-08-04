import { useEffect, useRef, useState } from "react"

export type ListView = "days" | "week" | "threads"

type MinimalTopbarProps = {
  readonly mode: "minimal"
}

type OnboardingTopbarProps = {
  readonly mode: "onboarding"
  readonly view: ListView | "project"
  readonly onView: (view: ListView) => void
  readonly onToggleSort: () => void
}

type LoadedTopbarProps = {
  readonly mode: "loaded"
  readonly view: ListView | "project"
  readonly onView: (view: ListView) => void
  readonly onToggleSort: () => void
  readonly boundary: 4 | 5 | 6 | 7
  readonly setBoundary: (boundary: 4 | 5 | 6 | 7) => Promise<void>
  readonly halo: 0 | 5 | 10 | 15
  readonly setHalo: (halo: 0 | 5 | 10 | 15) => Promise<void>
}

export type TopbarProps = MinimalTopbarProps | OnboardingTopbarProps | LoadedTopbarProps

const tabs: [ListView, string][] = [
  ["days", "days"],
  ["week", "week"],
  ["threads", "threads"],
]

export function Topbar(props: TopbarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [saving, setSaving] = useState<"boundary" | "halo" | null>(null)
  const controlsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!settingsOpen) return
    const onDown = (event: MouseEvent) => {
      if (!controlsRef.current?.contains(event.target as Node)) setSettingsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [settingsOpen])

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="wordmark">trails</span>
        {props.mode !== "minimal" && (
          <>
            <nav className="nav" aria-label="views">
              {tabs.map(([key, label]) => (
                <button
                  key={key}
                  className={`nav-link${props.view === key ? " is-on" : ""}`}
                  onClick={() => props.onView(key)}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="controls" ref={controlsRef}>
              <button className="quiet-btn" onClick={props.onToggleSort}>
                {props.mode === "onboarding" ? "organize projects" : "sort projects"}
              </button>
              {props.mode === "loaded" && (
                <>
                  <button
                    className="quiet-btn"
                    aria-expanded={settingsOpen}
                    onClick={() => setSettingsOpen(!settingsOpen)}
                  >
                    settings
                  </button>
                  <div className="settings-pop" hidden={!settingsOpen}>
                    <label className="control">
                      <span>day starts</span>
                      <select
                        value={props.boundary}
                        disabled={saving === "boundary"}
                        onChange={async (event) => {
                          setSaving("boundary")
                          try {
                            await props.setBoundary(Number(event.target.value) as 4 | 5 | 6 | 7)
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
                        value={props.halo}
                        disabled={saving === "halo"}
                        onChange={async (event) => {
                          setSaving("halo")
                          try {
                            await props.setHalo(Number(event.target.value) as 0 | 5 | 10 | 15)
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
                </>
              )}
            </div>
          </>
        )}
      </div>
    </header>
  )
}
