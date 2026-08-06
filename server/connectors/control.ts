import {
  AUTH_PATH,
  loadCredentials,
  removeCredential,
  setCredential,
  type ApiCredential,
} from "../../cli/auth"
import {
  loadHubConfig,
  SERVER_CONFIG_PATH,
  writeHubConfig,
  type SummarizerConfig,
} from "../../cli/config"
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from "../../shared/providers"
import {
  pollChatgptDeviceFlow,
  startChatgptDeviceFlow,
  type ChatgptDeviceFlow,
} from "./chatgpt-login"
import type { SummarizerManager } from "./manager"
import {
  createOpenrouterPkceFlow,
  exchangeOpenrouterCode,
  matchesOpenrouterState,
  type OpenrouterPkceFlow,
} from "./openrouter-auth"
import { SummarizeError, type SummarizeErrorClass } from "./types"

export type ActiveSummarizerState = "never_ran" | "ok" | "failing"

export interface ProviderConnectionStatus {
  readonly id: ProviderId
  readonly label: string
  readonly company: string
  readonly login: "pkce" | "device-code" | "api-key"
  readonly apiKeyFallback: boolean
  readonly unofficial: boolean
  readonly defaultModel: string
  readonly loggedIn: boolean
}

export interface ConnectorStatus {
  readonly providers: ReadonlyArray<ProviderConnectionStatus>
  readonly active: {
    readonly provider: ProviderId
    readonly model: string
    readonly state: ActiveSummarizerState
    readonly lastAttemptAt: number | null
    readonly lastSuccessAt: number | null
    readonly lastErrorClass: SummarizeErrorClass | null
  } | null
  readonly legacyRelay: boolean
}

export type ChatgptLoginPoll =
  | { readonly state: "pending" }
  | { readonly state: "logged_in" }
  | { readonly state: "failed"; readonly errorClass: SummarizeErrorClass }

export interface ConnectorControl {
  status(): ConnectorStatus
  startChatgpt(): Promise<{
    readonly userCode: string
    readonly verificationUrl: string
    readonly expiresAt: number
    readonly intervalSeconds: number
  }>
  pollChatgpt(): Promise<ChatgptLoginPoll>
  startOpenrouter(callbackUrl: string): { readonly authorizeUrl: string }
  finishOpenrouter(state: string, code: string): Promise<void>
  setApiKey(provider: "openrouter" | "openai-api", key: string): void
  activate(selection: SummarizerConfig): void
  disconnect(): void
  logout(provider: ProviderId): void
}

export interface ConnectorControlOptions {
  readonly manager: SummarizerManager
  readonly authPath?: string
  readonly configPath?: string
  readonly fetcher?: typeof globalThis.fetch
  readonly now?: () => number
}

function errorClass(error: unknown): SummarizeErrorClass {
  return error instanceof SummarizeError ? error.errorClass : "protocol"
}

export function createConnectorControl(options: ConnectorControlOptions): ConnectorControl {
  const authPath = options.authPath ?? AUTH_PATH
  const configPath = options.configPath ?? SERVER_CONFIG_PATH
  const fetcher = options.fetcher ?? globalThis.fetch
  const now = options.now ?? Date.now
  let chatgptFlow: ChatgptDeviceFlow | null = null
  let chatgptPoll: Promise<ChatgptLoginPoll> | null = null
  const openrouterFlows = new Map<string, OpenrouterPkceFlow>()

  const pruneOpenrouterFlows = (): void => {
    const current = now()
    for (const [state, flow] of openrouterFlows) {
      if (current >= flow.expiresAt) openrouterFlows.delete(state)
    }
    while (openrouterFlows.size > 8) {
      const oldest = openrouterFlows.keys().next().value
      if (typeof oldest !== "string") break
      openrouterFlows.delete(oldest)
    }
  }

  return {
    status() {
      const credentials = loadCredentials(authPath)
      const config = loadHubConfig(configPath)
      const selected = config?.summarizer ?? null
      const runtime = options.manager.status
      return {
        providers: PROVIDER_IDS.map((id) => ({
          id,
          label: PROVIDERS[id].label,
          company: PROVIDERS[id].company,
          login: PROVIDERS[id].login,
          apiKeyFallback: PROVIDERS[id].apiKeyFallback,
          unofficial: PROVIDERS[id].unofficial,
          defaultModel: PROVIDERS[id].defaultModel,
          loggedIn: id in credentials,
        })),
        active: selected
          ? {
              provider: selected.provider,
              model: selected.model ?? PROVIDERS[selected.provider].defaultModel,
              state: runtime.lastErrorClass !== null ? "failing" : runtime.lastSuccessAt !== null ? "ok" : "never_ran",
              lastAttemptAt: runtime.lastAttemptAt,
              lastSuccessAt: runtime.lastSuccessAt,
              lastErrorClass: runtime.lastErrorClass,
            }
          : null,
        legacyRelay: config?.legacyRelay ?? false,
      }
    },

    async startChatgpt() {
      const flow = await startChatgptDeviceFlow({ fetcher, now: now() })
      chatgptFlow = flow
      return {
        userCode: flow.userCode,
        verificationUrl: flow.verificationUrl,
        expiresAt: flow.expiresAt,
        intervalSeconds: flow.intervalSeconds,
      }
    },

    async pollChatgpt() {
      if (!chatgptFlow) return { state: "failed", errorClass: "auth_required" }
      if (chatgptPoll) return chatgptPoll
      const flow = chatgptFlow
      chatgptPoll = (async (): Promise<ChatgptLoginPoll> => {
        try {
          const result = await pollChatgptDeviceFlow(flow, { fetcher, now: now() })
          if (result.state === "pending") return result
          setCredential("chatgpt", result.credential, authPath)
          chatgptFlow = null
          return { state: "logged_in" }
        } catch (error) {
          const failure = errorClass(error)
          if (failure !== "network" && failure !== "timeout") chatgptFlow = null
          return { state: "failed", errorClass: failure }
        } finally {
          chatgptPoll = null
        }
      })()
      return chatgptPoll
    },

    startOpenrouter(callbackUrl) {
      pruneOpenrouterFlows()
      const flow = createOpenrouterPkceFlow(callbackUrl, { now: now() })
      openrouterFlows.set(flow.state, flow)
      return { authorizeUrl: flow.authorizeUrl }
    },

    async finishOpenrouter(state, code) {
      pruneOpenrouterFlows()
      const flow = openrouterFlows.get(state)
      if (!flow || !matchesOpenrouterState(flow.state, state)) throw new SummarizeError("auth_required")
      try {
        const credential = await exchangeOpenrouterCode(flow, code, { fetcher, now: now() })
        setCredential("openrouter", credential, authPath)
      } finally {
        openrouterFlows.delete(state)
      }
    },

    setApiKey(provider, rawKey) {
      const key = rawKey.trim()
      if (!key || key.length > 4_096 || /[\r\n]/.test(key)) throw new Error("API key must be one non-empty line")
      const credential: ApiCredential = { type: "api", key }
      setCredential(provider, credential, authPath)
    },

    activate(selection) {
      const credentials = loadCredentials(authPath)
      if (!(selection.provider in credentials)) throw new Error("provider is not logged in")
      writeHubConfig(selection, configPath)
    },

    disconnect() {
      writeHubConfig(null, configPath)
    },

    logout(provider) {
      removeCredential(provider, authPath)
      if (loadHubConfig(configPath)?.summarizer?.provider === provider) writeHubConfig(null, configPath)
    },
  }
}
