import { createRoot } from "react-dom/client"
import { App } from "./App"
import type { Scan, Summaries } from "./lib/data"
import "./styles.css"

async function boot() {
  const root = createRoot(document.getElementById("root")!)
  try {
    const scan: Scan = await fetch("/data/scan.json").then((r) => {
      if (!r.ok) throw new Error(`scan.json: ${r.status}`)
      return r.json()
    })
    // summaries are optional — the app runs fine before the summarizer has
    const summaries: Summaries | null = await fetch("/data/summaries.json")
      .then((r) => (r.ok ? (r.json() as Promise<Summaries>) : null))
      .catch(() => null)
    root.render(<App scan={scan} summaries={summaries} />)
  } catch (err) {
    root.render(
      <main id="main">
        <p className="view-intro">
          No scan data yet — run <code>bun run scan</code> to build <code>public/data/scan.json</code>, then reload.
        </p>
        <p className="view-intro" style={{ color: "var(--muted)" }}>
          {String(err)}
        </p>
      </main>,
    )
  }
}

boot()
