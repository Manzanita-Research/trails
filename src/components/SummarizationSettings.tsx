import { useCallback, useEffect, useState } from "react"
import type {
  ChatgptLoginStartV1,
  ConnectorStatusV1,
  SummarizationStatusV1,
} from "../../shared/protocol"
import { PROVIDERS, type ProviderId } from "../../shared/providers"
import {
  activateSummarizer,
  disconnectSummarizer,
  fetchConnectors,
  fetchSummarization,
  logoutProvider,
  pollChatgptLogin,
  setProviderApiKey,
  startChatgptLogin,
  startOpenrouterLogin,
} from "../lib/api"

const actionFailure = "That change didn’t work. Try again."
const errorCopy = {
  auth_required: "Sign in again before summaries can resume.",
  quota: "The provider reports that its quota or balance is exhausted.",
  provider_rejected: "The provider rejected the selected model or request.",
  timeout: "The provider timed out. Trails will retry the queued job.",
  protocol: "The provider returned an unreadable response. Trails will retry the queued job.",
  network: "The provider could not be reached. Trails will retry the queued job.",
} as const

type BusyAction = "chatgpt" | "openrouter" | "api-key" | "activate" | "disconnect" | "logout" | null

function ApiKeyForm({
  provider,
  busy,
  onSaved,
}: {
  readonly provider: "openrouter" | "openai-api"
  readonly busy: boolean
  readonly onSaved: () => Promise<void>
}) {
  const [key, setKey] = useState("")
  const [failed, setFailed] = useState(false)
  const label = provider === "openrouter" ? "OpenRouter" : "OpenAI"

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailed(false)
    try {
      await setProviderApiKey(provider, key)
      setKey("")
      await onSaved()
    } catch {
      setFailed(true)
    }
  }

  return (
    <form className="provider-key-form" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`provider-key-${provider}`}>{label} API key</label>
      <div className="provider-key-entry">
        <input
          id={`provider-key-${provider}`}
          type="password"
          value={key}
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          onChange={(event) => setKey(event.target.value)}
        />
        <button type="submit" className="quiet-btn" disabled={busy || key.trim().length === 0}>save key</button>
      </div>
      <p className="provider-help">Stored once in the hub’s owner-only configuration. Trails never shows it again.</p>
      {failed && <p role="alert" className="provider-error">The key wasn’t saved. Check it and try again.</p>}
    </form>
  )
}

export function SummarizationSettings() {
  const [connectors, setConnectors] = useState<ConnectorStatusV1 | null>(null)
  const [summarization, setSummarization] = useState<SummarizationStatusV1 | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<BusyAction>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [chatgptFlow, setChatgptFlow] = useState<ChatgptLoginStartV1 | null>(null)
  const [openrouterUrl, setOpenrouterUrl] = useState<string | null>(null)
  const [confirmProvider, setConfirmProvider] = useState<ProviderId | null>(null)
  const [confirmLogout, setConfirmLogout] = useState<ProviderId | null>(null)
  const [models, setModels] = useState<Record<ProviderId, string>>({
    openrouter: PROVIDERS.openrouter.defaultModel,
    chatgpt: PROVIDERS.chatgpt.defaultModel,
    "openai-api": PROVIDERS["openai-api"].defaultModel,
  })

  const reload = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    setLoadFailed(false)
    try {
      const [nextConnectors, nextSummarization] = await Promise.all([
        fetchConnectors(),
        fetchSummarization(),
      ])
      setConnectors(nextConnectors)
      setSummarization(nextSummarization)
      setModels((current) => {
        const next = { ...current }
        for (const provider of nextConnectors.providers) {
          if (nextConnectors.active?.provider === provider.id) next[provider.id] = nextConnectors.active.model
        }
        return next
      })
    } catch {
      setLoadFailed(true)
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload(true)
    const params = new URLSearchParams(window.location.search)
    if (params.get("settings") !== "summarization") return
    if (params.get("connected") === "openrouter") {
      setNotice("OpenRouter is connected. Choose “use OpenRouter” to allow Trails to send digests.")
    } else if (params.has("connectError")) {
      setActionError("OpenRouter sign-in didn’t finish. Start it again.")
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`)
  }, [reload])

  useEffect(() => {
    if (!chatgptFlow) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const result = await pollChatgptLogin()
        if (cancelled) return
        if (result.state === "pending") {
          timer = window.setTimeout(() => void poll(), chatgptFlow.intervalSeconds * 1_000)
          return
        }
        setChatgptFlow(null)
        if (result.state === "logged_in") {
          setNotice("ChatGPT is connected. Choose “use ChatGPT” to allow Trails to send digests.")
          await reload()
        } else {
          setActionError(errorCopy[result.errorClass])
        }
      } catch {
        if (!cancelled) setActionError(actionFailure)
      }
    }
    timer = window.setTimeout(() => void poll(), chatgptFlow.intervalSeconds * 1_000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [chatgptFlow, reload])

  const startChatgpt = async () => {
    setBusy("chatgpt")
    setActionError(null)
    setNotice(null)
    try {
      setChatgptFlow(await startChatgptLogin())
    } catch {
      setActionError("ChatGPT sign-in couldn’t start. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const startOpenrouter = async () => {
    setBusy("openrouter")
    setActionError(null)
    setNotice(null)
    try {
      setOpenrouterUrl((await startOpenrouterLogin()).authorizeUrl)
    } catch {
      setActionError("OpenRouter sign-in couldn’t start. Try again.")
    } finally {
      setBusy(null)
    }
  }

  const activate = async (provider: ProviderId) => {
    setBusy("activate")
    setActionError(null)
    try {
      await activateSummarizer(provider, models[provider].trim())
      setConfirmProvider(null)
      setNotice(`${PROVIDERS[provider].label} will summarize new and queued digests.`)
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
      setNotice("Summaries are off. Provider logins were kept on this hub.")
      await reload()
    } catch {
      setActionError(actionFailure)
    } finally {
      setBusy(null)
    }
  }

  const logout = async (provider: ProviderId) => {
    setBusy("logout")
    setActionError(null)
    try {
      await logoutProvider(provider)
      setConfirmLogout(null)
      setNotice(`${PROVIDERS[provider].label} was logged out on this hub.`)
      await reload()
    } catch {
      setActionError(actionFailure)
    } finally {
      setBusy(null)
    }
  }

  const keySaved = async () => {
    setNotice("API key saved. Choose a provider below to allow Trails to send digests.")
    await reload()
  }

  if (loading) return <p className="settings-muted">Reading summarization configuration…</p>
  if (loadFailed || !connectors) {
    return (
      <p className="settings-load-error">
        Summarization settings couldn’t load. <button className="text-action" onClick={() => void reload(true)}>try again</button>
      </p>
    )
  }

  const active = connectors.active
  return (
    <div className="summarization-content">
      <div className="summarization-intro">
        <p>Summaries are made on this hub. Only bounded session and day digests go to the provider you explicitly choose.</p>
        {active ? (
          <div className="active-summarizer">
            <p>
              <strong>{PROVIDERS[active.provider].label}</strong>
              <span><code>{active.model}</code></span>
              <span>{active.state === "ok" ? "connected" : active.state === "never_ran" ? "ready; no summary attempted yet" : errorCopy[active.lastErrorClass ?? "protocol"]}</span>
            </p>
            <button className="quiet-btn" disabled={busy !== null} onClick={() => void disconnect()}>turn summaries off</button>
          </div>
        ) : (
          <p className="summaries-off">Summaries are off. Existing and queued timeline work stays local.</p>
        )}
        {connectors.legacyRelay && <p className="provider-notice">The previous relay setup was retired. Choose a provider below.</p>}
        {notice && <p role="status" className="provider-notice">{notice}</p>}
        {actionError && <p role="alert" className="provider-error">{actionError}</p>}
      </div>

      <div className="provider-list">
        {connectors.providers.map((provider) => {
          const isActive = active?.provider === provider.id
          const model = models[provider.id]
          const selectionChanged = !isActive || model.trim() !== active.model
          return (
            <article key={provider.id} className={`provider-row${isActive ? " provider-active" : ""}`}>
              <header>
                <div>
                  <h3>{provider.label}</h3>
                  <p>{provider.company} · {provider.loggedIn ? "connected on this hub" : "not connected"}</p>
                </div>
                {isActive && <span className="provider-badge">in use</span>}
              </header>

              {provider.unofficial && (
                <p className="provider-disclosure">
                  Unofficial connector. Trails uses OpenAI’s public Codex device login and ChatGPT Codex endpoint; OpenAI does not document this as a third-party integration.
                </p>
              )}

              {!provider.loggedIn && provider.id === "chatgpt" && (
                <div className="provider-connect-flow">
                  <button className="quiet-btn" disabled={busy !== null} onClick={() => void startChatgpt()}>connect ChatGPT</button>
                  {chatgptFlow && (
                    <div className="device-code" role="status">
                      <p>Open ChatGPT, then enter this one-time code:</p>
                      <strong>{chatgptFlow.userCode}</strong>
                      <a href={chatgptFlow.verificationUrl} target="_blank" rel="noreferrer">open ChatGPT sign-in ↗</a>
                      <p>Waiting for approval…</p>
                    </div>
                  )}
                </div>
              )}

              {!provider.loggedIn && provider.id === "openrouter" && (
                <div className="provider-connect-flow">
                  <button className="quiet-btn" disabled={busy !== null} onClick={() => void startOpenrouter()}>connect OpenRouter</button>
                  {openrouterUrl && <a href={openrouterUrl}>continue to OpenRouter ↗</a>}
                  <details>
                    <summary>use an existing API key instead</summary>
                    <ApiKeyForm provider="openrouter" busy={busy !== null} onSaved={keySaved} />
                  </details>
                </div>
              )}

              {!provider.loggedIn && provider.id === "openai-api" && (
                <ApiKeyForm provider="openai-api" busy={busy !== null} onSaved={keySaved} />
              )}

              {provider.loggedIn && (
                <div className="provider-controls">
                  <label htmlFor={`provider-model-${provider.id}`}>model</label>
                  <input
                    id={`provider-model-${provider.id}`}
                    value={model}
                    maxLength={200}
                    spellCheck={false}
                    disabled={busy !== null}
                    onChange={(event) => setModels((current) => ({ ...current, [provider.id]: event.target.value }))}
                  />
                  {selectionChanged && (
                    <button
                      className="quiet-btn"
                      disabled={busy !== null || model.trim().length === 0}
                      onClick={() => setConfirmProvider(provider.id)}
                    >
                      use {provider.label}
                    </button>
                  )}
                  <button className="text-action provider-logout" disabled={busy !== null} onClick={() => setConfirmLogout(provider.id)}>log out</button>
                </div>
              )}

              {confirmProvider === provider.id && (
                <div className="provider-confirm" role="alertdialog" aria-labelledby={`activate-${provider.id}`}>
                  <p id={`activate-${provider.id}`}>
                    Trails will send bounded digest text to {provider.company} using <code>{model.trim()}</code>. New and queued summaries will use this selection.
                  </p>
                  <div>
                    <button className="quiet-btn" disabled={busy !== null} onClick={() => void activate(provider.id)}>confirm and use</button>
                    <button className="text-action" disabled={busy !== null} onClick={() => setConfirmProvider(null)}>cancel</button>
                  </div>
                </div>
              )}

              {confirmLogout === provider.id && (
                <div className="provider-confirm" role="alertdialog" aria-labelledby={`logout-${provider.id}`}>
                  <p id={`logout-${provider.id}`}>Remove this provider login from Trails on the hub? Timeline data and queued jobs stay intact.</p>
                  <div>
                    <button className="quiet-btn" disabled={busy !== null} onClick={() => void logout(provider.id)}>confirm log out</button>
                    <button className="text-action" disabled={busy !== null} onClick={() => setConfirmLogout(null)}>cancel</button>
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

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
              <dd>A one-session day summary may be copied without a second model call.</dd>
            </div>
          </dl>
        </details>
      )}
    </div>
  )
}
