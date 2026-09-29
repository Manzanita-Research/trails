import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp, bootstrapOf } from "./authenticated-app"
import { openDatabase } from "../server/db"
import { buildReport } from "../plugins/bb-plugin-trails/client"
import { querySchema, reportSchema } from "../plugins/bb-plugin-trails/contract"

test("BB repository days consume real server project summaries and group sessions at the workday boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "trails-bb-contract-"))
  const db = openDatabase(join(root, "test.sqlite"), { defaultTimezone: "America/Los_Angeles" })
  try {
    const app = createApp({ db })
    const start = "2026-09-16T08:00:00.000Z" // 01:00 local, still the September 15 workday.
    const response = await app(new Request("http://localhost:7412/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocolVersion: 2, device: { id: "fixture", name: "Fixture" },
      sessions: ["trails", "other"].map(project => ({
        sourceSessionId: project, source: "codex", cwd: `/Users/tester/code/${project}`, branch: "main",
        start, end: "2026-09-16T08:01:00.000Z", events: 2, userEvents: 1, firstPrompt: `Work on ${project}`,
        activity: [[Date.parse(start) / 60_000, 2, 1]], digest: "Private input",
      })),
    }) }))
    expect(response.status).toBe(200)
    const { boundary } = db.sqlite.query("SELECT boundary FROM settings WHERE id = 1").get() as { boundary: number }
    for (const project of ["trails", "other"]) {
      db.sqlite.query("INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at) VALUES (?, ?, ?, 'test', ?, ?)")
        .run("2026-09-15", `code/${project}`, boundary, `${project} day summary`, Date.now())
    }
    const bootstrap = bootstrapOf(db)
    const report = buildReport(bootstrap, querySchema.parse({ view: "days" }), "local hub", new Date(), ["/Users/tester/code/trails"])
    expect(reportSchema.safeParse(report).success).toBe(true)
    expect(report.days).toHaveLength(1)
    expect(report.days[0].date).toBe("2026-09-15")
    expect(report.days[0].projects[0].summary).toBe("trails day summary")
    expect(report.days[0].sessions.map(session => session.firstPrompt)).toEqual(["Work on trails"])
    expect(JSON.stringify(report)).not.toContain("other day summary")
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})
