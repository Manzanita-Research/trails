import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import type { ApiCredential } from "../../cli/auth"
import { SummarizeError } from "./types"

export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth"
export const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"
export const OPENROUTER_FLOW_TTL_MS = 10 * 60_000

export interface OpenrouterPkceFlow {
  readonly state: string
  readonly verifier: string
  readonly authorizeUrl: string
  readonly expiresAt: number
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function createOpenrouterPkceFlow(
  callbackUrl: string,
  options: { readonly now?: number; readonly random?: (size: number) => Uint8Array } = {},
): OpenrouterPkceFlow {
  const callback = new URL(callbackUrl)
  if (callback.protocol !== "https:" && callback.hostname !== "127.0.0.1" && callback.hostname !== "localhost") {
    throw new Error("OpenRouter callback requires HTTPS except on loopback")
  }
  const random = options.random ?? randomBytes
  const verifier = base64url(random(48))
  const state = base64url(random(32))
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  callback.searchParams.set("state", state)
  const authorize = new URL(OPENROUTER_AUTHORIZE_URL)
  authorize.searchParams.set("callback_url", callback.toString())
  authorize.searchParams.set("code_challenge", challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  return {
    state,
    verifier,
    authorizeUrl: authorize.toString(),
    expiresAt: (options.now ?? Date.now()) + OPENROUTER_FLOW_TTL_MS,
  }
}

export function matchesOpenrouterState(expected: string, received: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(received)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function exchangeOpenrouterCode(
  flow: OpenrouterPkceFlow,
  code: string,
  options: {
    readonly fetcher?: typeof globalThis.fetch
    readonly now?: number
    readonly timeoutMs?: number
  } = {},
): Promise<ApiCredential> {
  if ((options.now ?? Date.now()) >= flow.expiresAt) throw new SummarizeError("auth_required")
  if (!code) throw new SummarizeError("auth_required")
  let response: Response
  try {
    response = await (options.fetcher ?? globalThis.fetch)(OPENROUTER_EXCHANGE_URL, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: flow.verifier,
        code_challenge_method: "S256",
      }),
    })
  } catch (cause) {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new SummarizeError("timeout")
    }
    throw new SummarizeError("network")
  }
  if (!response.ok) {
    throw new SummarizeError(response.status >= 500 ? "network" : "auth_required")
  }
  const body: unknown = await response.json().catch(() => null)
  if (typeof body !== "object" || body === null || !("key" in body) || typeof body.key !== "string" || !body.key) {
    throw new SummarizeError("protocol")
  }
  return { type: "api", key: body.key }
}
