export const PROVIDER_IDS = ["openrouter", "chatgpt", "openai-api"] as const

export type ProviderId = (typeof PROVIDER_IDS)[number]

export type LoginKind = "pkce" | "device-code" | "api-key"

export interface ProviderInfo {
  readonly id: ProviderId
  readonly label: string
  /** Company that receives digest text when this provider is active. */
  readonly company: string
  /** True when the login path is not an officially documented third-party interface. */
  readonly unofficial: boolean
  readonly login: LoginKind
  /** Whether a pasted API key is accepted in place of the primary login flow. */
  readonly apiKeyFallback: boolean
  /** Suggested model shown at activation; validated lazily by the provider. */
  readonly defaultModel: string
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    company: "OpenRouter",
    unofficial: false,
    login: "pkce",
    apiKeyFallback: true,
    defaultModel: "openrouter/auto",
  },
  chatgpt: {
    id: "chatgpt",
    label: "ChatGPT Plus/Pro (Codex subscription)",
    company: "OpenAI",
    unofficial: true,
    login: "device-code",
    apiKeyFallback: false,
    defaultModel: "gpt-5.2-codex",
  },
  "openai-api": {
    id: "openai-api",
    label: "OpenAI (API key)",
    company: "OpenAI",
    unofficial: false,
    login: "api-key",
    apiKeyFallback: true,
    defaultModel: "gpt-4o-mini",
  },
}

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value)
}
