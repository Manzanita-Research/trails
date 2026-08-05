import type { OauthCredential } from "../../cli/auth"
import { SummarizeError } from "./types"

/**
 * Public OAuth client of the Codex CLI (identical constant in openai/codex,
 * OpenCode, and Pi). Trails runs the same documented device-code and refresh
 * flows itself; it never reads another tool's credentials.
 */
export const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CHATGPT_ISSUER = "https://auth.openai.com"
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/oauth/token`
export const CHATGPT_DEVICE_CODE_URL = `${CHATGPT_ISSUER}/api/accounts/deviceauth/usercode`
export const CHATGPT_DEVICE_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/deviceauth/token`
export const CHATGPT_DEVICE_REDIRECT = `${CHATGPT_ISSUER}/deviceauth/callback`
export const CHATGPT_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

/** Refresh this long before token expiry. */
export const CHATGPT_EXPIRY_MARGIN_MS = 60_000

export interface TokenGrant {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

export function accountIdFromAccessToken(access: string): string | null {
  const parts = access.split(".")
  if (parts.length !== 3) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
    if (typeof payload !== "object" || payload === null || !("https://api.openai.com/auth" in payload)) return null
    const auth = payload["https://api.openai.com/auth"]
    if (typeof auth !== "object" || auth === null || !("chatgpt_account_id" in auth)) return null
    const accountId = auth.chatgpt_account_id
    return typeof accountId === "string" && accountId ? accountId : null
  } catch {
    return null
  }
}

export function grantFromTokenResponse(
  body: unknown,
  previous: { readonly refresh: string; readonly accountId?: string } | null,
): TokenGrant {
  if (typeof body !== "object" || body === null) throw new SummarizeError("protocol")
  const access = "access_token" in body ? body.access_token : null
  if (typeof access !== "string" || !access) throw new SummarizeError("protocol")
  const rotated = "refresh_token" in body ? body.refresh_token : null
  const refresh = typeof rotated === "string" && rotated ? rotated : previous?.refresh
  if (!refresh) throw new SummarizeError("protocol")
  const rawExpiry = "expires_in" in body ? body.expires_in : null
  const expiresIn = typeof rawExpiry === "number" && rawExpiry > 0 ? rawExpiry : 3_600
  const accountId = previous?.accountId ?? accountIdFromAccessToken(access) ?? undefined
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1_000,
    ...(accountId === undefined ? {} : { accountId }),
  }
}

export async function refreshChatgptGrant(
  credential: OauthCredential,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenGrant> {
  let response: Response
  try {
    response = await fetcher(CHATGPT_TOKEN_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
        client_id: CHATGPT_CLIENT_ID,
      }),
    })
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new SummarizeError("timeout")
    }
    throw new SummarizeError("network")
  }
  if (!response.ok) {
    throw new SummarizeError(response.status >= 400 && response.status < 500 ? "auth_required" : "network")
  }
  return grantFromTokenResponse(await response.json().catch(() => null), credential)
}
