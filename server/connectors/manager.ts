import { statSync } from "node:fs"
import { AUTH_PATH } from "../../cli/auth"
import { loadHubConfig, SERVER_CONFIG_PATH, type SummarizerConfig } from "../../cli/config"
import { PROVIDERS, type ProviderId } from "../../shared/providers"
import { chatCompletionsSummarizer } from "./chat-completions"
import { createChatgptSummarizer } from "./chatgpt"
import type { Summarizer, SummarizeErrorClass } from "./types"

export interface SummaryRuntimeStatus {
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  lastErrorClass: SummarizeErrorClass | null
}

export interface SummarizerDescription {
  readonly provider: ProviderId
  readonly model: string
}

export interface SummarizerManager {
  current(): Summarizer | null
  describe(): SummarizerDescription | null
  readonly status: SummaryRuntimeStatus
}

export interface ConnectorDeps {
  readonly authPath?: string
  readonly fetcher?: typeof globalThis.fetch
  readonly timeoutMs?: number
}

export function buildSummarizer(selection: SummarizerConfig, deps: ConnectorDeps = {}): Summarizer {
  const model = selection.model ?? PROVIDERS[selection.provider].defaultModel
  switch (selection.provider) {
    case "chatgpt":
      return createChatgptSummarizer({ model, ...deps })
    case "openrouter":
      return chatCompletionsSummarizer({
        provider: "openrouter",
        model,
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { "X-Title": "Trails" },
        ...deps,
      })
    case "openai-api":
      return chatCompletionsSummarizer({
        provider: "openai-api",
        model,
        url: "https://api.openai.com/v1/chat/completions",
        ...deps,
      })
  }
}

function fileStamp(path: string): string {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}:${info.ino}`
  } catch {
    return "absent"
  }
}

/**
 * Rebuilds the active summarizer whenever server.json changes, so `trails
 * connect`/`use`/`disconnect` apply on the supervisor's next poll without a
 * restart. Credentials are read per call by the connectors themselves, so
 * auth.json changes need no rebuild.
 */
export function createSummarizerManager(
  options: ConnectorDeps & { readonly configPath?: string } = {},
): SummarizerManager {
  const configPath = options.configPath ?? SERVER_CONFIG_PATH
  const deps: ConnectorDeps = {
    authPath: options.authPath ?? AUTH_PATH,
    fetcher: options.fetcher,
    timeoutMs: options.timeoutMs,
  }
  let stamp: string | null = null
  let selection: SummarizerConfig | null = null
  let summarizer: Summarizer | null = null
  const status: SummaryRuntimeStatus = { lastSuccessAt: null, lastAttemptAt: null, lastErrorClass: null }

  const reload = (): void => {
    const next = fileStamp(configPath)
    if (next === stamp) return
    stamp = next
    selection = null
    summarizer = null
    try {
      const loaded = loadHubConfig(configPath)
      if (loaded?.legacyRelay) {
        console.warn("legacy relay configuration is retired; run `trails connect` on the hub")
        return
      }
      if (!loaded?.summarizer) return
      selection = loaded.summarizer
      summarizer = buildSummarizer(loaded.summarizer, deps)
    } catch {
      console.warn("server configuration is invalid; summaries are paused")
    }
  }

  return {
    status,
    current() {
      reload()
      return summarizer
    },
    describe() {
      reload()
      return selection
        ? { provider: selection.provider, model: selection.model ?? PROVIDERS[selection.provider].defaultModel }
        : null
    },
  }
}
