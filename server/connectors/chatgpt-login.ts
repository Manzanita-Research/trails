import type { OauthCredential } from "../../cli/auth"
import {
  CHATGPT_CLIENT_ID,
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_DEVICE_REDIRECT,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_TOKEN_URL,
  accountIdFromAccessToken,
  grantFromTokenResponse,
} from "./chatgpt-oauth"
import { SummarizeError } from "./types"

const DEFAULT_INTERVAL_SECONDS = 5
const DEFAULT_EXPIRY_SECONDS = 900

export interface ChatgptDeviceFlow {
  readonly deviceAuthId: string
  readonly userCode: string
  readonly verificationUrl: string
  readonly intervalSeconds: number
  readonly expiresAt: number
}

export type ChatgptPollResult =
  | { readonly state: "pending" }
  | { readonly state: "logged_in"; readonly credential: OauthCredential }

function nonEmptyField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) return null
  const value = Reflect.get(body, key)
  return typeof value === "string" && value ? value : null
}

function positiveNumberField(body: unknown, key: string, fallback: number): number {
  if (typeof body !== "object" || body === null || !(key in body)) return fallback
  const value = Reflect.get(body, key)
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

async function request(
  url: string,
  init: RequestInit,
  fetcher: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new SummarizeError("timeout")
    }
    throw new SummarizeError("network")
  }
}

export async function startChatgptDeviceFlow(
  options: {
    readonly fetcher?: typeof globalThis.fetch
    readonly now?: number
    readonly timeoutMs?: number
  } = {},
): Promise<ChatgptDeviceFlow> {
  const fetcher = options.fetcher ?? globalThis.fetch
  const response = await request(
    CHATGPT_DEVICE_CODE_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CHATGPT_CLIENT_ID }),
    },
    fetcher,
    options.timeoutMs ?? 30_000,
  )
  if (!response.ok) {
    throw new SummarizeError(response.status >= 500 ? "network" : "provider_rejected")
  }
  const body: unknown = await response.json().catch(() => null)
  const deviceAuthId = nonEmptyField(body, "device_auth_id")
  const userCode = nonEmptyField(body, "user_code")
  const verificationUrl =
    nonEmptyField(body, "verification_uri_complete") ??
    nonEmptyField(body, "verification_uri") ??
    nonEmptyField(body, "verification_url")
  if (!deviceAuthId || !userCode || !verificationUrl) throw new SummarizeError("protocol")
  const intervalSeconds = positiveNumberField(body, "interval", DEFAULT_INTERVAL_SECONDS)
  const expiresIn = positiveNumberField(body, "expires_in", DEFAULT_EXPIRY_SECONDS)
  return {
    deviceAuthId,
    userCode,
    verificationUrl,
    intervalSeconds,
    expiresAt: (options.now ?? Date.now()) + expiresIn * 1_000,
  }
}

export async function pollChatgptDeviceFlow(
  flow: ChatgptDeviceFlow,
  options: {
    readonly fetcher?: typeof globalThis.fetch
    readonly now?: number
    readonly timeoutMs?: number
  } = {},
): Promise<ChatgptPollResult> {
  if ((options.now ?? Date.now()) >= flow.expiresAt) throw new SummarizeError("auth_required")
  const fetcher = options.fetcher ?? globalThis.fetch
  const response = await request(
    CHATGPT_DEVICE_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: flow.deviceAuthId, user_code: flow.userCode }),
    },
    fetcher,
    options.timeoutMs ?? 30_000,
  )
  if (response.status === 403 || response.status === 404) return { state: "pending" }
  if (!response.ok) {
    throw new SummarizeError(response.status >= 500 ? "network" : "auth_required")
  }
  const deviceGrant: unknown = await response.json().catch(() => null)
  const authorizationCode = nonEmptyField(deviceGrant, "authorization_code")
  const codeVerifier = nonEmptyField(deviceGrant, "code_verifier")
  if (!authorizationCode || !codeVerifier) throw new SummarizeError("protocol")

  const tokenResponse = await request(
    CHATGPT_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: CHATGPT_DEVICE_REDIRECT,
        client_id: CHATGPT_CLIENT_ID,
        code_verifier: codeVerifier,
      }),
    },
    fetcher,
    options.timeoutMs ?? 30_000,
  )
  if (!tokenResponse.ok) {
    throw new SummarizeError(tokenResponse.status >= 500 ? "network" : "auth_required")
  }
  const grant = grantFromTokenResponse(await tokenResponse.json().catch(() => null), null)
  const accountId = grant.accountId ?? accountIdFromAccessToken(grant.access)
  if (!accountId) throw new SummarizeError("protocol")
  return {
    state: "logged_in",
    credential: {
      type: "oauth",
      access: grant.access,
      refresh: grant.refresh,
      expires: grant.expires,
      accountId,
    },
  }
}
