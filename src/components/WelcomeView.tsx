import { useEffect, useState } from "react"
import { ALPHA_INSTALLER_URL } from "../../shared/release"

type CopyState = "idle" | "copied" | "failed"

function clientSetupCommand(hubUrl: string): string | null {
  try {
    if (new URL(hubUrl).protocol !== "https:") return null
  } catch {
    return null
  }
  return `curl -fsSL ${ALPHA_INSTALLER_URL} | sh -s -- join ${hubUrl} --pairing-file pairing.json`
}

export function WelcomeView({
  hubUrl,
  retry,
  syncError,
}: {
  readonly hubUrl: string
  readonly retry: () => Promise<void>
  readonly syncError: string | null
}) {
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState(false)
  const command = clientSetupCommand(hubUrl)
  const [copyState, setCopyState] = useState<CopyState>("idle")

  useEffect(() => setCopyState("idle"), [command])

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

  const copyCommand = async () => {
    if (command === null) return
    try {
      await navigator.clipboard.writeText(command)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
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
        {command !== null && (
          <section className="welcome-join" aria-labelledby="welcome-join-title">
            <h2 id="welcome-join-title">Add another Mac</h2>
            <p>On the hub, create a pairing file with <code>trails auth pair --server {hubUrl} --output pairing.json --name Laptop</code>.
              Transfer it privately to the other Mac, then run this command there:</p>
            <div className="welcome-command-row">
              <code className="welcome-command">{command}</code>
              <button className="text-action welcome-copy-button" type="button" onClick={() => void copyCommand()}>
                {copyState === "copied" ? "copied" : "copy"}
              </button>
            </div>
            <p className="welcome-join-note">The pairing file gives this Mac permission to upload its own sessions.</p>
            {copyState === "failed" && <p role="alert">Couldn’t copy — select the command instead.</p>}
          </section>
        )}
        <details className="welcome-troubleshooting">
          <summary>troubleshooting</summary>
          <p>
            Run <code className="welcome-command">~/.local/bin/trails collect --once</code> on the source Mac. If you
            haven’t used a supported agent yet, setup is complete — come back after your next session.
            {command === null && (
              <>
                {" "}
                To add another Mac, rerun hub setup with <code>--tailscale</code>; this page will then show its exact
                setup command.
              </>
            )}
          </p>
        </details>
      </div>
    </section>
  )
}
