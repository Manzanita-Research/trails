import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCredential } from "../cli/auth"
import { loadHubConfig } from "../cli/config"
import { createApp } from "../server/app"
import { createConnectorControl } from "../server/connectors/control"
import {
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_TOKEN_URL,
} from "../server/connectors/chatgpt-oauth"
import { createSummarizerManager } from "../server/connectors/manager"
import { OPENROUTER_EXCHANGE_URL } from "../server/connectors/openrouter-auth"
import { openDatabase, type TrailsDb } from "../server/db"

const roots: string[] = []
const databases = new Set<TrailsDb>()

afterEach(() => {
  for (const database of databases) database.close()
  databases.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url")
  return `header.${payload}.signature`
}

async function body(response: Response): Promise<unknown> {
  return response.json()
}

function jsonRequest(url: string, value?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  })
}

describe("connector API", () => {
  test("completes provider logins and mutations without exposing or persisting secrets outside auth.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-connector-api-"))
    roots.push(root)
    const authPath = join(root, "auth.json")
    const configPath = join(root, "server.json")
    const database = openDatabase(":memory:")
    databases.add(database)
    let devicePolls = 0
    const accessSecret = jwt("private-account-id")
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === CHATGPT_DEVICE_CODE_URL) {
        return Response.json({
          device_auth_id: "private-device-id",
          user_code: "USER-CODE",
          verification_uri: "https://auth.openai.com/device",
          interval: 1,
          expires_in: 600,
        })
      }
      if (url === CHATGPT_DEVICE_TOKEN_URL) {
        devicePolls += 1
        if (devicePolls === 1) return new Response(null, { status: 403 })
        return Response.json({ authorization_code: "private-auth-code", code_verifier: "private-verifier" })
      }
      if (url === CHATGPT_TOKEN_URL) {
        return Response.json({ access_token: accessSecret, refresh_token: "private-refresh", expires_in: 3_600 })
      }
      if (url === OPENROUTER_EXCHANGE_URL) return Response.json({ key: "private-openrouter-key" })
      return new Response(null, { status: 404 })
    }) as typeof globalThis.fetch
    const manager = createSummarizerManager({ configPath, authPath, fetcher })
    const connectors = createConnectorControl({ manager, configPath, authPath, fetcher })
    const app = createApp({ db: database, summarization: manager, connectors })
    const origin = "https://hub.test"

    let response = await app(jsonRequest(`${origin}/api/connect/chatgpt/start`))
    expect(response.status).toBe(200)
    const started = await body(response)
    expect(started).toEqual({
      userCode: "USER-CODE",
      verificationUrl: "https://auth.openai.com/device",
      expiresAt: expect.any(Number),
      intervalSeconds: 1,
    })
    expect(JSON.stringify(started)).not.toContain("private-device-id")

    response = await app(jsonRequest(`${origin}/api/connect/chatgpt/poll`))
    expect(await body(response)).toEqual({ state: "pending" })
    response = await app(jsonRequest(`${origin}/api/connect/chatgpt/poll`))
    expect(await body(response)).toEqual({ state: "logged_in" })
    expect(getCredential("chatgpt", authPath)).toMatchObject({
      type: "oauth",
      refresh: "private-refresh",
      accountId: "private-account-id",
    })

    response = await app(
      jsonRequest(`${origin}/api/connect/openai-api/apikey`, { key: "private-openai-key" }),
    )
    expect(await body(response)).toEqual({ ok: true })
    expect(getCredential("openai-api", authPath)).toEqual({ type: "api", key: "private-openai-key" })

    response = await app(
      jsonRequest(`${origin}/api/summarizer`, { provider: "openai-api", model: "gpt-test" }),
    )
    expect(await body(response)).toEqual({ ok: true })
    expect(loadHubConfig(configPath)?.summarizer).toEqual({ provider: "openai-api", model: "gpt-test" })

    response = await app(new Request(`${origin}/api/connectors`))
    expect(response.status).toBe(200)
    expect(await body(response)).toMatchObject({
      protocolVersion: 1,
      active: {
        provider: "openai-api",
        model: "gpt-test",
        state: "never_ran",
        lastErrorClass: null,
      },
      legacyRelay: false,
    })

    response = await app(jsonRequest(`${origin}/api/connect/openrouter/start`))
    const openrouterStart = await body(response)
    expect(openrouterStart).toEqual({ authorizeUrl: expect.any(String) })
    if (
      typeof openrouterStart !== "object" ||
      openrouterStart === null ||
      !("authorizeUrl" in openrouterStart) ||
      typeof openrouterStart.authorizeUrl !== "string"
    ) {
      throw new Error("expected OpenRouter authorize URL")
    }
    const callback = new URL(new URL(openrouterStart.authorizeUrl).searchParams.get("callback_url") ?? "")
    callback.searchParams.set("code", "approval-code")
    response = await app(new Request(callback))
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe("https://hub.test/?settings=summarization&connected=openrouter")
    expect(response.headers.get("location")).not.toContain("private-openrouter-key")
    expect(getCredential("openrouter", authPath)).toEqual({ type: "api", key: "private-openrouter-key" })

    response = await app(jsonRequest(`${origin}/api/logout/openai-api`))
    expect(await body(response)).toEqual({ ok: true })
    expect(getCredential("openai-api", authPath)).toBeNull()
    expect(loadHubConfig(configPath)?.summarizer).toBeNull()

    const browserBodies = await Promise.all([
      app(new Request(`${origin}/api/bootstrap`)).then((result) => result.text()),
      app(new Request(`${origin}/api/summarization`)).then((result) => result.text()),
      app(new Request(`${origin}/api/connectors`)).then((result) => result.text()),
    ])
    const sqliteBytes = Buffer.from(database.sqlite.serialize()).toString("utf8")
    const publicText = [...browserBodies, sqliteBytes].join("\n")
    for (const secret of [
      "private-device-id",
      "private-auth-code",
      "private-verifier",
      accessSecret,
      "private-refresh",
      "private-account-id",
      "private-openai-key",
      "private-openrouter-key",
    ]) {
      expect(publicText).not.toContain(secret)
    }
  })

  test("fails closed for missing credentials, invalid providers, malformed keys, and stale callback state", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-connector-api-errors-"))
    roots.push(root)
    const authPath = join(root, "auth.json")
    const configPath = join(root, "server.json")
    const database = openDatabase(":memory:")
    databases.add(database)
    const fetcher = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ key: "should-not-land" })) as typeof globalThis.fetch
    const manager = createSummarizerManager({ configPath, authPath, fetcher })
    const connectors = createConnectorControl({ manager, configPath, authPath, fetcher })
    const app = createApp({ db: database, summarization: manager, connectors })
    const origin = "https://hub.test"

    let response = await app(jsonRequest(`${origin}/api/summarizer`, { provider: "openrouter" }))
    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({
      error: { code: "invalid_request", message: "provider is not logged in or model is invalid" },
    })

    response = await app(jsonRequest(`${origin}/api/connect/chatgpt/apikey`, { key: "not-allowed" }))
    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({
      error: { code: "invalid_request", message: "provider does not accept API keys" },
    })

    response = await app(jsonRequest(`${origin}/api/connect/openai-api/apikey`, { key: "line-one\nline-two" }))
    expect(response.status).toBe(400)
    expect(getCredential("openai-api", authPath)).toBeNull()

    response = await app(
      new Request(`${origin}/api/connect/openrouter/callback?state=unknown&code=code`),
    )
    expect(response.status).toBe(303)
    expect(response.headers.get("location")).toBe(
      "https://hub.test/?settings=summarization&connectError=auth_required",
    )
    expect(getCredential("openrouter", authPath)).toBeNull()

    response = await app(jsonRequest(`${origin}/api/logout/not-a-provider`))
    expect(response.status).toBe(400)
    expect(await body(response)).toEqual({
      error: { code: "invalid_request", message: "unknown provider" },
    })
  })
})
