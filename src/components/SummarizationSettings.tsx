import { useCallback, useEffect, useState } from "react"
import {
  HARNESS_AUTO_ORDER,
  HARNESSES,
  type HarnessSelection,
} from "../../shared/harnesses"
import type { HarnessStatusV1, SummarizationStatusV2 } from "../../shared/protocol"
import {
  activateSummarizer,
  disconnectSummarizer,
  fetchHarnesses,
  fetchSummarization,
} from "../lib/api"

const actionFailure = "That change didn’t work. Try again."
const errorCopy = {
  auth_required: "The harness needs you to sign in on this hub.",
  quota: "The harness reports that its provider quota or balance is exhausted.",
  harness_failed: "The harness could not complete the summary. Trails will retry the queued job.",
  timeout: "The harness timed out. Trails will retry the queued job.",
  protocol: "The harness returned an unreadable response. Trails will retry the queued job.",
} as const

type BusyAction = "activate" | "disconnect" | null

export function SummarizationSettings() {
  const [harnesses, setHarnesses] = useState<HarnessStatusV1 | null>(null)
  const [summarization, setSummarization] = useState<SummarizationStatusV2 | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmSelection, setConfirmSelection] = useState<HarnessSelection | null>(null)

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadFailed(false)
    try {
      const [nextHarnesses, nextSummarization] = await Promise.all([
        fetchHarnesses(),
        fetchSummarization(),
      ])
      setHarnesses(nextHarnesses)
      setSummarization(nextSummarization)
    } catch {
      setLoadFailed(true)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(true)
    const timer = window.setInterval(() => void reload(), 30_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const activate = async (selection: HarnessSelection) => {
    setBusy("activate")
    setActionError(null)
    try {
      await activateSummarizer(selection)
      setConfirmSelection(null)
      setNotice(`${selection === "auto" ? "Automatic harness selection" : HARNESSES[selection].label} will summarize new and queued digests.`)
      await reload()
    } catch {
      setActionError(actionFailure)
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async () => {
    setBusy("disconnect")
    setActionError(null)
    try {
      await disconnectSummarizer()
      setNotice("Summaries are off. Harness logins and queued work were left untouched.")
      await reload()
    } catch {
      setActionError(actionFailure)
    } finally {
      setBusy(null)
    }
  }

  if (loading) return <p className="settings-muted">Reading summarization configuration…</p>
  if (loadFailed || !harnesses) {
    return (
      <p className="settings-load-error">
        Summarization settings couldn’t load. <button className="text-action" onClick={() => void reload(true)}>try again</button>
      </p>
    )
  }

  const active = harnesses.active
  const available = harnesses.harnesses.filter((harness) => harness.available)
  const activeLabel = active?.harness ? HARNESSES[active.harness].label : null
  return (
    <div className="summarization-content">
      <div className="summarization-intro">
        <p>
          Trails asks an installed coding harness on this hub to summarize bounded session and day digests. The harness uses its own login; Trails never reads or copies its credentials.
        </p>
        {active ? (
          <div className="active-summarizer">
            <p>
              <strong>{active.selection === "auto" ? "automatic" : HARNESSES[active.selection].label}</strong>
              <span>{activeLabel ? `using ${activeLabel}` : "no matching harness found"}</span>
              <span>{active.state === "ok"
                ? "working"
                : active.state === "never_ran"
                  ? "ready; no summary attempted yet"
                  : active.state === "unavailable"
                    ? "unavailable on this hub"
                    : errorCopy[active.lastErrorClass ?? "protocol"]}</span>
            </p>
            <button className="quiet-btn" disabled={busy !== null} onClick={() => void disconnect()}>turn summaries off</button>
          </div>
        ) : (
          <p className="summaries-off">Summaries are off. Existing and queued timeline work stays local.</p>
        )}
        {notice && <p role="status" className="provider-notice">{notice}</p>}
        {actionError && <p role="alert" className="provider-error">{actionError}</p>}
      </div>

      <div className="provider-list">
        <article className={`provider-row${active?.selection === "auto" ? " provider-active" : ""}`}>
          <header>
            <div>
              <h3>Automatic</h3>
              <p>{available.length > 0 ? `first available: ${HARNESS_AUTO_ORDER.map((id) => HARNESSES[id].label).join(" → ")}` : "no supported harness found"}</p>
            </div>
            {active?.selection === "auto" && <span className="provider-badge">in use</span>}
          </header>
          {active?.selection !== "auto" && (
            <button className="quiet-btn" disabled={busy !== null || available.length === 0} onClick={() => setConfirmSelection("auto")}>use automatic</button>
          )}
        </article>

        {harnesses.harnesses.map((harness) => {
          const isActive = active?.selection === harness.id
          return (
            <article key={harness.id} className={`provider-row${isActive ? " provider-active" : ""}`}>
              <header>
                <div>
                  <h3>{harness.label}</h3>
                  <p>{harness.available ? "installed on this hub" : "not found on this hub"}</p>
                </div>
                {isActive && <span className="provider-badge">in use</span>}
              </header>
              {!isActive && (
                <button className="quiet-btn" disabled={busy !== null || !harness.available} onClick={() => setConfirmSelection(harness.id)}>use {harness.label}</button>
              )}
            </article>
          )
        })}
      </div>

      {confirmSelection !== null && (
        <div className="provider-confirm" role="alertdialog" aria-labelledby="activate-harness">
          <p id="activate-harness">
            Trails will invoke {confirmSelection === "auto" ? "the first available harness" : HARNESSES[confirmSelection].label} on this hub. New and queued bounded digests will be sent through the provider that harness already uses.
          </p>
          <div>
            <button className="quiet-btn" disabled={busy !== null} onClick={() => void activate(confirmSelection)}>confirm and use</button>
            <button className="text-action" disabled={busy !== null} onClick={() => setConfirmSelection(null)}>cancel</button>
          </div>
        </div>
      )}

      {summarization?.enabled === true && (
        <details className="summarization-details">
          <summary>prompt details</summary>
          <dl className="summarization-values">
            <div>
              <dt>session prompt</dt>
              <dd><pre>{summarization.metadata.prompts.session}</pre></dd>
            </div>
            <div>
              <dt>day prompt</dt>
              <dd><pre>{summarization.metadata.prompts.day}</pre></dd>
            </div>
            <div>
              <dt className="sr-only">one-session behavior</dt>
              <dd>A one-session day summary may be copied without a second harness call.</dd>
            </div>
          </dl>
        </details>
      )}
    </div>
  )
}
