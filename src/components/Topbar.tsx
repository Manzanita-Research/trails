import { useEffect, useRef, useState, type RefObject } from "react"

export type ListView = "days" | "week" | "threads"

type MinimalTopbarProps = {
  readonly mode: "minimal"
}

type OrganizationTriggerProps = {
  readonly organizeExpanded: boolean
  readonly organizeControls: string
  readonly organizeTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onOrganize: () => void
}

type OnboardingTopbarProps = OrganizationTriggerProps & {
  readonly mode: "onboarding"
  readonly view: ListView | "project"
  readonly onView: (view: ListView) => void
}

type LoadedTopbarProps = OrganizationTriggerProps & {
  readonly mode: "loaded"
  readonly view: ListView | "project"
  readonly onView: (view: ListView) => void
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
  const settingsDialogRef = useRef<HTMLDivElement>(null)
  const settingsTriggerRef = useRef<HTMLButtonElement>(null)
  const firstSettingsSelectRef = useRef<HTMLSelectElement>(null)
  const settingsWasOpenRef = useRef(false)
  const settingsId = "settings-dialog"

  useEffect(() => {
    if (!settingsOpen) {
      if (settingsWasOpenRef.current) {
        settingsWasOpenRef.current = false
        settingsTriggerRef.current?.focus()
      }
      return
    }

    settingsWasOpenRef.current = true
    firstSettingsSelectRef.current?.focus()

    const onDown = (event: MouseEvent) => {
      const target = event.target as Node
      const onTrigger = settingsTriggerRef.current?.contains(target)
      const inDialog = settingsDialogRef.current?.contains(target)
      if (!onTrigger && !inDialog) setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      setSettingsOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [settingsOpen])

  useEffect(() => {
    if (props.mode !== "loaded") setSettingsOpen(false)
  }, [props.mode])

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
            <div className="controls">
              <button
                ref={props.organizeTriggerRef}
                className="quiet-btn"
                aria-expanded={props.organizeExpanded}
                aria-controls={props.organizeControls}
                onClick={props.onOrganize}
              >
                organize projects
              </button>
              {props.mode === "loaded" && (
                <>
                  <button
                    ref={settingsTriggerRef}
                    className="quiet-btn"
                    aria-expanded={settingsOpen}
                    aria-controls={settingsId}
                    onClick={() => setSettingsOpen((open) => !open)}
                  >
                    settings
                  </button>
                  <div
                    ref={settingsDialogRef}
                    id={settingsId}
                    className="settings-pop"
                    role="dialog"
                    aria-label="settings"
                    hidden={!settingsOpen}
                  >
                    <label className="control">
                      <span>day starts</span>
                      <select
                        ref={firstSettingsSelectRef}
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
                    <label className="control control-with-help">
                      <span className="control-copy">
                        <span>attention halo</span>
                        <span id="attention-halo-help" className="control-help">
                          nearby reading, reviewing, and thinking time counted around your prompts
                        </span>
                      </span>
                      <select
                        aria-label="attention halo"
                        aria-describedby="attention-halo-help"
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
