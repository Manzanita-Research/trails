// zero-dependency static server for the trails prototype
import { join, normalize } from "node:path"

const ROOT = join(import.meta.dir, "..")
const PORT = Number(process.env.TRAILS_PORT ?? 7412)

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    let path = normalize(url.pathname)
    if (path === "/" || path === "") path = "/index.html"
    if (path.includes("..")) return new Response("nope", { status: 400 })
    const file = Bun.file(join(ROOT, path))
    if (!(await file.exists())) return new Response("not found", { status: 404 })
    const ext = path.slice(path.lastIndexOf("."))
    return new Response(file, { headers: { "content-type": TYPES[ext] ?? "application/octet-stream" } })
  },
})

console.log(`trails serving on http://localhost:${PORT}`)
