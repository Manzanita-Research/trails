import { SummarizationMetadataV1Schema, decodeExact } from "../shared/protocol"

export interface Env {
  readonly AI: {
    run(model: string, input: { readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>; readonly max_tokens: number }): Promise<unknown>
  }
  readonly TRAILS_AI_TOKEN: string
}

export const MODEL = "@cf/moonshotai/kimi-k2.5"

export const SESSION_SYSTEM = `You summarize coding-agent work sessions for a personal work journal. Reply with one or two plain sentences and nothing else: the core contribution of the session (what was built, changed, investigated, or decided), plus anything left open if it matters. Past tense, specific, compact. No preamble, no bullet points, no quotes around your answer.`

export const DAY_SYSTEM = `You join several session summaries from one working day on one project into a single short journal entry. Reply with one or two plain sentences and nothing else: what actually got done that day on this project, folding overlapping sessions together. Past tense, specific, compact.`

function completionText(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null
  if ("response" in result && typeof result.response === "string") return result.response.trim()
  if ("result" in result && typeof result.result === "object" && result.result !== null && "response" in result.result) {
    return typeof result.result.response === "string" ? result.result.response.trim() : null
  }
  if (!("choices" in result) || !Array.isArray(result.choices)) return null
  const first = result.choices[0]
  if (typeof first !== "object" || first === null || !("message" in first)) return null
  const message = first.message
  if (typeof message !== "object" || message === null || !("content" in message)) return null
  return typeof message.content === "string" ? message.content.trim() : null
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== "/api/summarize") return new Response("not found", { status: 404 })
    if (!env.TRAILS_AI_TOKEN || request.headers.get("authorization") !== `Bearer ${env.TRAILS_AI_TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 })
    }
    if (request.method === "GET") {
      return Response.json(
        decodeExact(SummarizationMetadataV1Schema, {
          protocolVersion: 1,
          model: MODEL,
          prompts: { session: SESSION_SYSTEM, day: DAY_SYSTEM },
        }),
      )
    }
    if (request.method !== "POST") return Response.json({ error: "method not allowed" }, { status: 405 })

    let input: unknown
    try {
      input = await request.json()
    } catch {
      return Response.json({ error: "invalid request" }, { status: 400 })
    }
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).length !== 2 ||
      !("kind" in input) ||
      !("input" in input) ||
      (input.kind !== "session" && input.kind !== "day") ||
      typeof input.input !== "string" ||
      input.input.length === 0 ||
      input.input.length > (input.kind === "session" ? 9_000 : 12_000)
    ) {
      return Response.json({ error: "invalid request" }, { status: 400 })
    }

    try {
      const result = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: input.kind === "session" ? SESSION_SYSTEM : DAY_SYSTEM },
          { role: "user", content: input.input },
        ],
        max_tokens: 4096,
      })
      const text = completionText(result)
      if (!text) return Response.json({ error: "model returned no text" }, { status: 502 })
      return Response.json({ text, model: MODEL })
    } catch {
      return Response.json({ error: "model request failed" }, { status: 502 })
    }
  },
}

export default worker
