// trails worker — the ai binding lives here so summarization never touches api keys.
// in dev the binding proxies through wrangler's oauth login; deployed, it's native.

interface Env {
  AI: Ai
}

const MODEL = "@cf/moonshotai/kimi-k2.5" // hosted natively on workers ai

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === "/api/summarize" && req.method === "POST") {
      let body: { system?: string; user?: string }
      try {
        body = await req.json()
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 })
      }
      if (!body.system || !body.user) {
        return Response.json({ error: "system and user required" }, { status: 400 })
      }
      try {
        const result: any = await env.AI.run(
          MODEL as any,
          {
            messages: [
              { role: "system", content: body.system },
              { role: "user", content: body.user },
            ],
            max_tokens: 4096, // kimi reasons before it answers; leave plenty of room
          },
        )
        // binding responses vary by model family — normalize to one field
        const text: string | undefined =
          result?.response ?? result?.choices?.[0]?.message?.content ?? result?.result?.response
        if (!text) return Response.json({ error: `empty completion: ${JSON.stringify(result).slice(0, 300)}` }, { status: 502 })
        return Response.json({ text: text.trim() })
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 })
      }
    }

    return new Response("not found", { status: 404 })
  },
}
