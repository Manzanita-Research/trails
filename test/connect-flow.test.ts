import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCredential, setCredential } from "../cli/auth"
import { runConnectorCommand } from "../cli/connect"
import { loadHubConfig } from "../cli/config"
import {
  createConnectorControl,
  type ChatgptLoginPoll,
  type ConnectorControl,
  type ConnectorStatus,
} from "../server/connectors/control"
import {
  pollChatgptDeviceFlow,
  startChatgptDeviceFlow,
} from "../server/connectors/chatgpt-login"
import {
  CHATGPT_DEVICE_CODE_URL,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_TOKEN_URL,
} from "../server/connectors/chatgpt-oauth"
import { createSummarizerManager } from "../server/connectors/manager"
import {
  createOpenrouterPkceFlow,
  exchangeOpenrouterCode,
  OPENROUTER_EXCHANGE_URL,
} from "../server/connectors/openrouter-auth"
import type { SummarizerConfig } from "../cli/config"
import type { ProviderId } from "../shared/providers"

let dir: string
let authPath: string
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trails-connect-flow-"))
  authPath = join(dir, "auth.json")
  configPath = join(dir, "server.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface Call {
  readonly url: string
  readonly init: RequestInit
}

function recordingFetch(
  handler: (url: string, init: RequestInit, callIndex: number) => Response | Promise<Response>,
): { readonly fetcher: typeof globalThis.fetch; readonly calls: Call[] } {
  const calls: Call[] = []
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init, calls.length - 1)
  }) as typeof globalThis.fetch
  return { fetcher, calls }
}

function jwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url")
  return `header.${payload}.signature`
}

describe("ChatGPT device flow", () => {
  test("starts, reports pending, exchanges approval, and extracts the account claim", async () => {
    const access = jwt("acct-test")
    const { fetcher, calls } = recordingFetch((url, init, index) => {
      if (url === CHATGPT_DEVICE_CODE_URL) {
        return Response.json({
          device_auth_id: "device-secret",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.openai.com/codex/device",
          interval: 2,
          expires_in: 600,
        })
      }
      if (url === CHATGPT_DEVICE_TOKEN_URL && index === 1) return new Response(null, { status: 403 })
      if (url === CHATGPT_DEVICE_TOKEN_URL) {
        return Response.json({ authorization_code: "authorization-secret", code_verifier: "verifier-secret" })
      }
      expect(url).toBe(CHATGPT_TOKEN_URL)
      expect(String(init.body)).toContain("code=authorization-secret")
      expect(String(init.body)).toContain("code_verifier=verifier-secret")
      return Response.json({ access_token: access, refresh_token: "refresh-secret", expires_in: 3_600 })
    })

    const flow = await startChatgptDeviceFlow({ fetcher, now: 1_000 })
    expect(flow).toEqual({
      deviceAuthId: "device-secret",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalSeconds: 2,
      expiresAt: 601_000,
    })
    expect(await pollChatgptDeviceFlow(flow, { fetcher, now: 2_000 })).toEqual({ state: "pending" })
    const result = await pollChatgptDeviceFlow(flow, { fetcher, now: 3_000 })
    expect(result.state).toBe("logged_in")
    if (result.state === "logged_in") {
      expect(result.credential).toMatchObject({
        type: "oauth",
        access,
        refresh: "refresh-secret",
        accountId: "acct-test",
      })
      expect(result.credential.expires).toBeGreaterThan(Date.now())
    }
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" })
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      device_auth_id: "device-secret",
      user_code: "ABCD-EFGH",
    })
  })

  test("rejects expired and malformed grants without returning provider details", async () => {
    const malformed = recordingFetch(() => Response.json({ user_code: "only-one-field" }))
    await expect(startChatgptDeviceFlow({ fetcher: malformed.fetcher })).rejects.toMatchObject({
      errorClass: "protocol",
    })

    const flow = {
      deviceAuthId: "d",
      userCode: "u",
      verificationUrl: "https://example.test",
      intervalSeconds: 5,
      expiresAt: 10,
    }
    await expect(pollChatgptDeviceFlow(flow, { now: 10 })).rejects.toMatchObject({
      errorClass: "auth_required",
    })
  })
})

describe("OpenRouter PKCE", () => {
  test("binds state into the callback and exchanges a code for a revocable key", async () => {
    const flow = createOpenrouterPkceFlow("https://hub.test/api/connect/openrouter/callback", {
      now: 1_000,
      random: (size) => new Uint8Array(size).fill(size),
    })
    const authorize = new URL(flow.authorizeUrl)
    const callback = new URL(authorize.searchParams.get("callback_url") ?? "")
    expect(callback.origin + callback.pathname).toBe("https://hub.test/api/connect/openrouter/callback")
    expect(callback.searchParams.get("state")).toBe(flow.state)
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256")
    expect(authorize.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(flow.verifier).digest("base64url"),
    )

    const { fetcher, calls } = recordingFetch(() => Response.json({ key: "openrouter-secret" }))
    expect(await exchangeOpenrouterCode(flow, "approval-code", { fetcher, now: 2_000 })).toEqual({
      type: "api",
      key: "openrouter-secret",
    })
    expect(calls[0].url).toBe(OPENROUTER_EXCHANGE_URL)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      code: "approval-code",
      code_verifier: flow.verifier,
      code_challenge_method: "S256",
    })
  })

  test("requires HTTPS away from loopback and rejects expired flows", async () => {
    expect(() => createOpenrouterPkceFlow("http://hub.test/callback")).toThrow("requires HTTPS")
    const flow = createOpenrouterPkceFlow("http://127.0.0.1:7412/callback", { now: 0 })
    await expect(exchangeOpenrouterCode(flow, "code", { now: flow.expiresAt })).rejects.toMatchObject({
      errorClass: "auth_required",
    })
  })
})

describe("connector control", () => {
  test("stores successful logins separately, activates explicitly, and disconnects active logout", async () => {
    const access = jwt("acct-control")
    let devicePolls = 0
    const { fetcher } = recordingFetch((url) => {
      if (url === CHATGPT_DEVICE_CODE_URL) {
        return Response.json({
          device_auth_id: "device-secret",
          user_code: "CODE",
          verification_uri: "https://auth.openai.com/device",
          interval: 1,
          expires_in: 60,
        })
      }
      if (url === CHATGPT_DEVICE_TOKEN_URL) {
        devicePolls += 1
        if (devicePolls === 1) return new Response(null, { status: 403 })
        return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" })
      }
      if (url === CHATGPT_TOKEN_URL) {
        return Response.json({ access_token: access, refresh_token: "refresh-secret", expires_in: 3600 })
      }
      if (url === OPENROUTER_EXCHANGE_URL) return Response.json({ key: "openrouter-secret" })
      return new Response(null, { status: 404 })
    })
    const manager = createSummarizerManager({ configPath, authPath, fetcher })
    const control = createConnectorControl({ manager, configPath, authPath, fetcher, now: () => 5_000 })

    expect(control.status().active).toBeNull()
    expect(control.status().providers.every((provider) => !provider.loggedIn)).toBe(true)
    const device = await control.startChatgpt()
    expect(device).toMatchObject({ userCode: "CODE", verificationUrl: "https://auth.openai.com/device" })
    expect(device).not.toHaveProperty("deviceAuthId")
    expect(await control.pollChatgpt()).toEqual({ state: "pending" })
    expect(await control.pollChatgpt()).toEqual({ state: "logged_in" })
    expect(control.status().providers.find(({ id }) => id === "chatgpt")?.loggedIn).toBe(true)
    expect(control.status().active).toBeNull()

    control.activate({ provider: "chatgpt", model: "gpt-test" })
    expect(loadHubConfig(configPath)?.summarizer).toEqual({ provider: "chatgpt", model: "gpt-test" })
    expect(control.status().active).toMatchObject({
      provider: "chatgpt",
      model: "gpt-test",
      state: "never_ran",
    })

    control.setApiKey("openai-api", "  api-secret  ")
    expect(getCredential("openai-api", authPath)).toEqual({ type: "api", key: "api-secret" })
    control.logout("chatgpt")
    expect(getCredential("chatgpt", authPath)).toBeNull()
    expect(loadHubConfig(configPath)?.summarizer).toBeNull()
  })

  test("a failed login preserves an existing credential", async () => {
    setCredential("openrouter", { type: "api", key: "working-secret" }, authPath)
    const { fetcher } = recordingFetch(() => new Response("denied", { status: 403 }))
    const manager = createSummarizerManager({ configPath, authPath, fetcher })
    const control = createConnectorControl({ manager, configPath, authPath, fetcher })
    const { authorizeUrl } = control.startOpenrouter("https://hub.test/callback")
    const callback = new URL(new URL(authorizeUrl).searchParams.get("callback_url") ?? "")

    await expect(control.finishOpenrouter(callback.searchParams.get("state") ?? "", "bad-code")).rejects.toMatchObject({
      errorClass: "auth_required",
    })
    expect(getCredential("openrouter", authPath)).toEqual({ type: "api", key: "working-secret" })
  })
})

function fakeStatus(): ConnectorStatus {
  return {
    protocolVersion: 1,
    providers: [
      {
        id: "openrouter",
        label: "OpenRouter",
        company: "OpenRouter",
        login: "pkce",
        apiKeyFallback: true,
        unofficial: false,
        defaultModel: "openrouter/auto",
        loggedIn: true,
      },
      {
        id: "chatgpt",
        label: "ChatGPT Plus/Pro (Codex subscription)",
        company: "OpenAI",
        login: "device-code",
        apiKeyFallback: false,
        unofficial: true,
        defaultModel: "gpt-5.2-codex",
        loggedIn: false,
      },
      {
        id: "openai-api",
        label: "OpenAI (API key)",
        company: "OpenAI",
        login: "api-key",
        apiKeyFallback: true,
        unofficial: false,
        defaultModel: "gpt-4o-mini",
        loggedIn: false,
      },
    ],
    active: null,
    legacyRelay: false,
  }
}

function fakeControl(overrides: Partial<ConnectorControl> = {}): {
  readonly control: ConnectorControl
  readonly activated: SummarizerConfig[]
  readonly keys: Array<{ provider: string; key: string }>
  readonly logouts: ProviderId[]
  readonly disconnects: { count: number }
} {
  const activated: SummarizerConfig[] = []
  const keys: Array<{ provider: string; key: string }> = []
  const logouts: ProviderId[] = []
  const disconnects = { count: 0 }
  const control: ConnectorControl = {
    status: fakeStatus,
    startChatgpt: async () => ({
      userCode: "CODE",
      verificationUrl: "https://auth.test/device",
      expiresAt: Date.now() + 60_000,
      intervalSeconds: 1,
    }),
    pollChatgpt: async (): Promise<ChatgptLoginPoll> => ({ state: "logged_in" }),
    startOpenrouter: () => ({ authorizeUrl: "https://openrouter.test/auth" }),
    finishOpenrouter: async () => {},
    setApiKey: (provider, key) => keys.push({ provider, key }),
    activate: (selection) => activated.push(selection),
    disconnect: () => {
      disconnects.count += 1
    },
    logout: (provider) => logouts.push(provider),
    ...overrides,
  }
  return { control, activated, keys, logouts, disconnects }
}

describe("connector CLI", () => {
  test("stores API keys from stdin without printing them", async () => {
    const harness = fakeControl()
    const output: string[] = []
    await runConnectorCommand("connect", ["openai-api", "--api-key-stdin"], {
      control: harness.control,
      readStdin: async () => "cli-secret\n",
      print: (message) => output.push(message),
    })
    expect(harness.keys).toEqual([{ provider: "openai-api", key: "cli-secret\n" }])
    expect(output.join("\n")).not.toContain("cli-secret")
  })

  test("requires activation consent and supports explicit model selection", async () => {
    const declined = fakeControl()
    const declinedOutput: string[] = []
    await runConnectorCommand("use", ["openrouter", "--model", "openai/gpt-test"], {
      control: declined.control,
      prompt: async () => "n",
      print: (message) => declinedOutput.push(message),
    })
    expect(declined.activated).toEqual([])
    expect(declinedOutput.join(" ")).toContain("never sends transcripts")

    const accepted = fakeControl()
    await runConnectorCommand("use", ["openrouter", "--model", "openai/gpt-test", "--yes"], {
      control: accepted.control,
      print: () => {},
    })
    expect(accepted.activated).toEqual([{ provider: "openrouter", model: "openai/gpt-test" }])
  })

  test("runs the device flow, renders status, logout, and disconnect", async () => {
    let polls = 0
    const harness = fakeControl({
      pollChatgpt: async () => {
        polls += 1
        return polls === 1 ? { state: "pending" } : { state: "logged_in" }
      },
    })
    const output: string[] = []
    const sleeps: number[] = []
    await runConnectorCommand("connect", ["chatgpt"], {
      control: harness.control,
      print: (message) => output.push(message),
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds)
      },
    })
    expect(sleeps).toEqual([1_000, 1_000])
    expect(output.join(" ")).toContain("unofficial")
    expect(output.join(" ")).toContain("CODE")

    await runConnectorCommand("connect", ["status"], { control: harness.control, print: (line) => output.push(line) })
    expect(output.join(" ")).toContain("● OpenRouter")
    expect(output.join(" ")).toContain("Active: summaries off")

    await runConnectorCommand("logout", ["openrouter"], { control: harness.control, print: () => {} })
    await runConnectorCommand("disconnect", [], { control: harness.control, print: () => {} })
    expect(harness.logouts).toEqual(["openrouter"])
    expect(harness.disconnects.count).toBe(1)
  })
})
