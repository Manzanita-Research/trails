import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getCredential, setCredential } from "../cli/auth"
import { writeHubConfig } from "../cli/config"
import { DAY_SYSTEM, SESSION_SYSTEM } from "../shared/prompts"
import { chatCompletionsSummarizer } from "../server/connectors/chat-completions"
import { createChatgptSummarizer } from "../server/connectors/chatgpt"
import { CHATGPT_RESPONSES_URL, CHATGPT_TOKEN_URL } from "../server/connectors/chatgpt-oauth"
import { buildSummarizer, createSummarizerManager } from "../server/connectors/manager"
import { SummarizeError, type Summarizer } from "../server/connectors/types"

let dir: string
let authPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trails-connectors-"))
  authPath = join(dir, "auth.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

interface RecordedRequest {
  readonly url: string
  readonly headers: Headers
  readonly body: unknown
}

function fetcherOf(
  handler: (url: string, init: RequestInit, calls: RecordedRequest[]) => Response | Promise<Response>,
): { fetcher: typeof globalThis.fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const rawBody = typeof init?.body === "string" ? init.body : init?.body?.toString() ?? ""
    let body: unknown = rawBody
    try {
      body = JSON.parse(rawBody)
    } catch {
      // keep raw string (form-encoded token requests)
    }
    calls.push({ url, headers: new Headers(init?.headers), body })
    return handler(url, init ?? {}, calls)
  }) as typeof globalThis.fetch
  return { fetcher, calls }
}

async function errorClassOf(client: Summarizer, kind: "session" | "day" = "session"): Promise<string> {
  const error = await Effect.runPromise(Effect.flip(client.summarize(kind, "digest text")))
  expect(error).toBeInstanceOf(SummarizeError)
  return error.errorClass
}

describe("chat-completions connectors", () => {
  test("posts bounded prompt and returns trimmed text with reported model", async () => {
    setCredential("openrouter", { type: "api", key: "sk-or-key" }, authPath)
    const { fetcher, calls } = fetcherOf(() =>
      Response.json({
        model: "openai/gpt-5-mini",
        choices: [{ message: { content: "  Shipped the connector work.  " } }],
      }),
    )
    const client = chatCompletionsSummarizer({
      provider: "openrouter",
      model: "openrouter/auto",
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: { "X-Title": "Trails" },
      authPath,
      fetcher,
    })

    const result = await Effect.runPromise(client.summarize("session", "digest text"))
    expect(result).toEqual({ text: "Shipped the connector work.", model: "openai/gpt-5-mini" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(calls[0].headers.get("authorization")).toBe("Bearer sk-or-key")
    expect(calls[0].headers.get("x-title")).toBe("Trails")
    expect(calls[0].body).toEqual({
      model: "openrouter/auto",
      max_tokens: 4096,
      messages: [
        { role: "system", content: SESSION_SYSTEM },
        { role: "user", content: "digest text" },
      ],
    })
  })

  test("uses the day prompt for day jobs", async () => {
    setCredential("openai-api", { type: "api", key: "sk-oa" }, authPath)
    const { fetcher, calls } = fetcherOf(() =>
      Response.json({ choices: [{ message: { content: "A full day." } }] }),
    )
    const client = chatCompletionsSummarizer({
      provider: "openai-api",
      model: "gpt-4o-mini",
      url: "https://api.openai.com/v1/chat/completions",
      authPath,
      fetcher,
    })
    const result = await Effect.runPromise(client.summarize("day", "day input"))
    expect(result.model).toBe("gpt-4o-mini")
    expect(calls[0].body).toMatchObject({
      messages: [
        { role: "system", content: DAY_SYSTEM },
        { role: "user", content: "day input" },
      ],
    })
  })

  test("maps missing credential and status codes to sanitized classes", async () => {
    const statuses: Array<[number, string]> = [
      [401, "auth_required"],
      [403, "auth_required"],
      [402, "quota"],
      [429, "quota"],
      [400, "provider_rejected"],
      [500, "network"],
    ]
    const clientFor = (fetcher: typeof globalThis.fetch) =>
      chatCompletionsSummarizer({
        provider: "openrouter",
        model: "openrouter/auto",
        url: "https://openrouter.ai/api/v1/chat/completions",
        authPath,
        fetcher,
      })

    const { fetcher: unused, calls } = fetcherOf(() => Response.json({}))
    expect(await errorClassOf(clientFor(unused))).toBe("auth_required")
    expect(calls).toHaveLength(0)

    setCredential("openrouter", { type: "api", key: "sk-or-key" }, authPath)
    for (const [status, expected] of statuses) {
      const { fetcher } = fetcherOf(() => new Response("denied", { status }))
      expect(await errorClassOf(clientFor(fetcher))).toBe(expected)
    }
  })

  test("maps malformed, empty, and hung responses to protocol and timeout", async () => {
    setCredential("openrouter", { type: "api", key: "sk-or-key" }, authPath)
    const base = {
      provider: "openrouter" as const,
      model: "openrouter/auto",
      url: "https://openrouter.ai/api/v1/chat/completions",
      authPath,
    }

    const { fetcher: malformed } = fetcherOf(() => new Response("not json", { status: 200 }))
    expect(await errorClassOf(chatCompletionsSummarizer({ ...base, fetcher: malformed }))).toBe("protocol")

    const { fetcher: empty } = fetcherOf(() => Response.json({ choices: [{ message: { content: "   " } }] }))
    expect(await errorClassOf(chatCompletionsSummarizer({ ...base, fetcher: empty }))).toBe("protocol")

    const hung = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      })) as typeof globalThis.fetch
    expect(await errorClassOf(chatCompletionsSummarizer({ ...base, fetcher: hung, timeoutMs: 25 }))).toBe(
      "timeout",
    )
  })
})

const FUTURE = Date.now() + 60 * 60_000

function sseBody(text: string, model = "gpt-5.2-codex"): string {
  const completed = JSON.stringify({
    type: "response.completed",
    response: { model, output: [{ type: "message", content: [{ type: "output_text", text }] }] },
  })
  return [
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(0, 3) })}`,
    "",
    `data: ${completed}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n")
}

describe("chatgpt connector", () => {
  test("sends codex-shaped request with subscription headers", async () => {
    setCredential(
      "chatgpt",
      { type: "oauth", access: "at-1", refresh: "rt-1", expires: FUTURE, accountId: "acct-9" },
      authPath,
    )
    const { fetcher, calls } = fetcherOf(() => new Response(sseBody("Wrote the plan."), { status: 200 }))
    const client = createChatgptSummarizer({ model: "gpt-5.2-codex", authPath, fetcher })

    const result = await Effect.runPromise(client.summarize("session", "digest text"))
    expect(result).toEqual({ text: "Wrote the plan.", model: "gpt-5.2-codex" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(CHATGPT_RESPONSES_URL)
    expect(calls[0].headers.get("authorization")).toBe("Bearer at-1")
    expect(calls[0].headers.get("chatgpt-account-id")).toBe("acct-9")
    expect(calls[0].headers.get("originator")).toBe("trails")
    expect(calls[0].headers.get("openai-beta")).toBe("responses=experimental")
    expect(calls[0].body).toEqual({
      model: "gpt-5.2-codex",
      instructions: SESSION_SYSTEM,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "digest text" }] }],
      stream: true,
      store: false,
    })
  })

  test("refreshes an expired grant, persists rotation, then summarizes", async () => {
    setCredential(
      "chatgpt",
      { type: "oauth", access: "at-old", refresh: "rt-old", expires: Date.now() - 1_000, accountId: "acct-9" },
      authPath,
    )
    const { fetcher, calls } = fetcherOf((url) => {
      if (url === CHATGPT_TOKEN_URL) {
        return Response.json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 3600 })
      }
      return new Response(sseBody("Refreshed and summarized."), { status: 200 })
    })
    const client = createChatgptSummarizer({ model: "gpt-5.2-codex", authPath, fetcher })

    const result = await Effect.runPromise(client.summarize("session", "digest text"))
    expect(result.text).toBe("Refreshed and summarized.")
    expect(calls[0].url).toBe(CHATGPT_TOKEN_URL)
    expect(String(calls[0].body)).toContain("grant_type=refresh_token")
    expect(String(calls[0].body)).toContain("refresh_token=rt-old")
    expect(calls[1].headers.get("authorization")).toBe("Bearer at-new")

    const stored = getCredential("chatgpt", authPath)
    expect(stored?.type).toBe("oauth")
    if (stored?.type === "oauth") {
      expect(stored.access).toBe("at-new")
      expect(stored.refresh).toBe("rt-new")
      expect(stored.accountId).toBe("acct-9")
      expect(stored.expires).toBeGreaterThan(Date.now())
    }
  })

  test("permanent refresh failure maps to auth_required and keeps the credential", async () => {
    const credential = {
      type: "oauth",
      access: "at-old",
      refresh: "rt-old",
      expires: Date.now() - 1_000,
      accountId: "acct-9",
    } as const
    setCredential("chatgpt", credential, authPath)
    const { fetcher } = fetcherOf(() => new Response("nope", { status: 400 }))
    const client = createChatgptSummarizer({ model: "gpt-5.2-codex", authPath, fetcher })

    expect(await errorClassOf(client)).toBe("auth_required")
    expect(getCredential("chatgpt", authPath)).toEqual(credential)
  })

  test("retries once with a forced refresh after a 401", async () => {
    setCredential(
      "chatgpt",
      { type: "oauth", access: "at-stale", refresh: "rt-1", expires: FUTURE, accountId: "acct-9" },
      authPath,
    )
    let apiCalls = 0
    const { fetcher, calls } = fetcherOf((url) => {
      if (url === CHATGPT_TOKEN_URL) {
        return Response.json({ access_token: "at-fresh", refresh_token: "rt-2", expires_in: 3600 })
      }
      apiCalls += 1
      if (apiCalls === 1) return new Response("expired", { status: 401 })
      return new Response(sseBody("Second try landed."), { status: 200 })
    })
    const client = createChatgptSummarizer({ model: "gpt-5.2-codex", authPath, fetcher })

    const result = await Effect.runPromise(client.summarize("session", "digest text"))
    expect(result.text).toBe("Second try landed.")
    expect(calls.map((call) => call.url)).toEqual([CHATGPT_RESPONSES_URL, CHATGPT_TOKEN_URL, CHATGPT_RESPONSES_URL])
    expect(calls[2].headers.get("authorization")).toBe("Bearer at-fresh")
  })

  test("maps failed and truncated streams to provider_rejected and protocol", async () => {
    setCredential(
      "chatgpt",
      { type: "oauth", access: "at-1", refresh: "rt-1", expires: FUTURE, accountId: "acct-9" },
      authPath,
    )
    const failed = fetcherOf(() =>
      new Response('data: {"type":"response.failed"}\n\n', { status: 200 }),
    )
    expect(await errorClassOf(createChatgptSummarizer({ model: "m", authPath, fetcher: failed.fetcher }))).toBe(
      "provider_rejected",
    )

    const truncated = fetcherOf(() =>
      new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', { status: 200 }),
    )
    expect(
      await errorClassOf(createChatgptSummarizer({ model: "m", authPath, fetcher: truncated.fetcher })),
    ).toBe("protocol")
  })

  test("missing login or account id maps to auth_required without any request", async () => {
    const { fetcher, calls } = fetcherOf(() => Response.json({}))
    const missing = createChatgptSummarizer({ model: "m", authPath, fetcher })
    expect(await errorClassOf(missing)).toBe("auth_required")

    setCredential("chatgpt", { type: "oauth", access: "at", refresh: "rt", expires: FUTURE }, authPath)
    const noAccount = createChatgptSummarizer({ model: "m", authPath, fetcher })
    expect(await errorClassOf(noAccount)).toBe("auth_required")
    expect(calls).toHaveLength(0)
  })
})

describe("summarizer manager", () => {
  test("follows config changes without a restart and ignores legacy relay files", () => {
    const configPath = join(dir, "server.json")
    const manager = createSummarizerManager({ configPath, authPath })
    expect(manager.current()).toBeNull()
    expect(manager.describe()).toBeNull()

    writeHubConfig({ provider: "chatgpt" }, configPath)
    expect(manager.describe()).toEqual({ provider: "chatgpt", model: "gpt-5.2-codex" })
    expect(manager.current()?.provider).toBe("chatgpt")

    writeHubConfig({ provider: "openrouter", model: "openai/gpt-5-mini" }, configPath)
    expect(manager.describe()).toEqual({ provider: "openrouter", model: "openai/gpt-5-mini" })
    expect(manager.current()?.provider).toBe("openrouter")

    writeHubConfig(null, configPath)
    expect(manager.current()).toBeNull()
    expect(manager.describe()).toBeNull()
  })

  test("treats a legacy V1 relay config as disconnected", () => {
    const configPath = join(dir, "server.json")
    writeFileSync(
      configPath,
      JSON.stringify({ protocolVersion: 1, aiUrl: "https://relay.example/api/summarize", aiToken: "t" }),
      { mode: 0o600 },
    )
    const manager = createSummarizerManager({ configPath, authPath })
    expect(manager.current()).toBeNull()
    expect(manager.describe()).toBeNull()
  })

  test("builds each provider with its default model", () => {
    expect(buildSummarizer({ provider: "chatgpt" }, { authPath }).model).toBe("gpt-5.2-codex")
    expect(buildSummarizer({ provider: "openrouter" }, { authPath }).model).toBe("openrouter/auto")
    expect(buildSummarizer({ provider: "openai-api" }, { authPath }).model).toBe("gpt-4o-mini")
  })
})
