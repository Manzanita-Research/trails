import { useState } from "react"

export function WelcomeView({
  retry,
  syncError,
}: {
  readonly retry: () => Promise<void>
  readonly syncError: string | null
}) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)

  const checkAgain = async () => {
    setChecking(true)
    setChecked(false)
    try {
      await retry()
      setChecked(true)
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="view welcome-view">
      <h1 className="display">Trails hasn’t received a supported session yet</h1>
      <div className="welcome-copy">
        <p>Trails watches Claude Code, Codex, omp, and pi. New work normally appears here within one minute.</p>
        <p>Transcripts are parsed on the source Mac. Transcript bodies never reach the hub.</p>
        <button className="text-action welcome-check" disabled={checking} onClick={() => void checkAgain()}>
          {checking ? "checking…" : "check again"}
        </button>
        {checked && !syncError && <p role="status">Checked just now — still waiting for a supported session.</p>}
        <details className="welcome-troubleshooting">
          <summary>troubleshooting</summary>
          <p>
            Run <code className="welcome-command">~/.local/bin/trails collect --once</code> on the source Mac. If you
            haven’t used a supported agent yet, setup is complete — come back after your next session.
          </p>
        </details>
      </div>
    </section>
  )
}
