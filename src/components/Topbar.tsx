import type { RefObject } from "react"

export type ListView = "days" | "week" | "threads"
export type AppView = ListView | "project" | "settings"

type FeedbackTriggerProps = {
  readonly feedbackExpanded: boolean
  readonly feedbackControls: string
  readonly feedbackTriggerRef: RefObject<HTMLButtonElement | null>
  readonly onFeedback: () => void
}

type MinimalTopbarProps = FeedbackTriggerProps & {
  readonly mode: "minimal"
}

type ApplicationTopbarProps = FeedbackTriggerProps & {
  readonly mode: "onboarding" | "loaded"
  readonly view: AppView
  readonly onView: (view: ListView) => void
  readonly onSettings: () => void
}

export type TopbarProps = MinimalTopbarProps | ApplicationTopbarProps

const tabs: [ListView, string][] = [
  ["days", "days"],
  ["week", "week"],
  ["threads", "threads"],
]

export function Topbar(props: TopbarProps) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <span className="wordmark">trails</span>
        {props.mode === "minimal" ? (
          <div className="controls">
            <button
              ref={props.feedbackTriggerRef}
              className="quiet-btn"
              aria-expanded={props.feedbackExpanded}
              aria-controls={props.feedbackControls}
              onClick={props.onFeedback}
            >
              feedback
            </button>
          </div>
        ) : (
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
                className="quiet-btn"
                aria-current={props.view === "settings" ? "page" : undefined}
                onClick={props.onSettings}
              >
                settings
              </button>
              <button
                ref={props.feedbackTriggerRef}
                className="quiet-btn"
                aria-expanded={props.feedbackExpanded}
                aria-controls={props.feedbackControls}
                onClick={props.onFeedback}
              >
                feedback
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  )
}
