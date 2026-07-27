// trails scanner — walks local Claude Code + Codex session logs and emits
// metadata-only JSON (no transcript content beyond a short first-prompt snippet).
//
// usage: bun scripts/scan.ts [--since 2026-06-22] [--out data/scan.json]

import { readdirSync, statSync, mkdirSync, writeFileSync, createReadStream } from "node:fs"
import { join, sep, basename, relative } from "node:path"
import { homedir } from "node:os"
import readline from "node:readline"

const HOME = homedir()
const CLAUDE_ROOT = join(HOME, ".claude/projects")
const CODEX_ROOT = join(HOME, ".codex/sessions")
const ZONE = "America/Los_Angeles"

const args = process.argv.slice(2)
const argVal = (flag: string, fallback: string) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const SINCE = argVal("--since", "2026-06-22")
const OUT = argVal("--out", join(import.meta.dir, "../data/scan.json"))
const sinceMs = new Date(`${SINCE}T00:00:00-07:00`).getTime()

// ---------- discovery ----------

function claudeFiles(): string[] {
  const files: string[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(CLAUDE_ROOT)
  } catch {
    return files
  }
  for (const dir of projectDirs) {
    // CodexBar's automated /usage probe sessions are noise, not work
    if (dir.endsWith("-Library-Application-Support-CodexBar-ClaudeProbe")) continue
    const full = join(CLAUDE_ROOT, dir)
    let entries: string[] = []
    try {
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue // skips subagent dirs too
      const fp = join(full, name)
      try {
        if (statSync(fp).mtimeMs >= sinceMs) files.push(fp)
      } catch {}
    }
  }
  return files
}

function codexFiles(): string[] {
  // date-partitioned: YYYY/MM/DD/rollout-*.jsonl — filter by path date, cheap
  const files: string[] = []
  const sinceDate = SINCE.replaceAll("-", "/")
  const visit = (dir: string) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === "subagents") continue
        visit(full)
      } else if (e.name.endsWith(".jsonl")) {
        const rel = relative(CODEX_ROOT, full)
        const datePart = rel.split(sep).slice(0, 3).join("/")
        if (datePart >= sinceDate) files.push(full)
      }
    }
  }
  visit(CODEX_ROOT)
  return files
}

// ---------- parsing ----------

const dtf = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

const partsCache = new Map<number, { date: string; minute: number }>()
function localParts(iso: string) {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return null
  const floored = Math.floor(t / 60000) * 60000
  const hit = partsCache.get(floored)
  if (hit) return hit
  const p = Object.fromEntries(
    dtf.formatToParts(floored).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]),
  ) as Record<string, string>
  const out = { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) }
  partsCache.set(floored, out)
  return out
}

const TS_RE = /"timestamp":"([^"]+)"/
const CWD_RE = /"cwd":"([^"]+)"/
const BRANCH_RE = /"gitBranch":"([^"]*)"/

function cleanSnippet(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240)
}

interface SessionMeta {
  id: string
  source: "claude" | "codex"
  cwd: string | null
  branch: string | null
  start: string | null
  end: string | null
  events: number
  userEvents: number
  firstPrompt: string | null
  // [localDate, minuteOfDay, eventCount, userEventCount]
  activity: [string, number, number, number][]
}

async function inspect(filePath: string, source: "claude" | "codex"): Promise<SessionMeta | null> {
  const id =
    source === "claude"
      ? basename(filePath, ".jsonl")
      : basename(filePath, ".jsonl").replace(/^rollout-[0-9T-]+-/, "")

  const buckets = new Map<string, [string, number, number, number]>()
  const meta: SessionMeta = {
    id,
    source,
    cwd: null,
    branch: null,
    start: null,
    end: null,
    events: 0,
    userEvents: 0,
    firstPrompt: null,
    activity: [],
  }

  const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  let lineNo = 0
  for await (const line of rl) {
    lineNo++
    if (!line) continue
    if (!meta.cwd) {
      const m = CWD_RE.exec(line)
      if (m) meta.cwd = m[1]
    }
    if (!meta.branch) {
      const m = BRANCH_RE.exec(line)
      if (m && m[1]) meta.branch = m[1]
    }

    const isUser =
      source === "claude"
        ? line.includes('"type":"user"') && !line.includes('"toolUseResult"') && !line.includes('"isMeta":true')
        : line.includes('"user_message"')

    if (isUser && !meta.firstPrompt && lineNo < 400) {
      try {
        const entry = JSON.parse(line)
        let text: string | null = null
        if (source === "claude") {
          const c = entry.message?.content
          if (typeof c === "string") text = c
          else if (Array.isArray(c)) text = c.find((b: any) => b.type === "text")?.text ?? null
        } else {
          text = entry.payload?.message ?? null
        }
        if (text && !text.startsWith("Caveat:") && !text.includes("command-name")) {
          const cleaned = cleanSnippet(text)
          if (cleaned.length > 2) meta.firstPrompt = cleaned
        }
      } catch {}
    }

    const tsMatch = TS_RE.exec(line)
    if (!tsMatch) continue
    const ts = tsMatch[1]
    const parts = localParts(ts)
    if (!parts) continue
    meta.events++
    if (isUser) meta.userEvents++
    if (!meta.start || ts < meta.start) meta.start = ts
    if (!meta.end || ts > meta.end) meta.end = ts
    const key = `${parts.date}:${parts.minute}`
    const b = buckets.get(key)
    if (b) {
      b[2]++
      if (isUser) b[3]++
    } else {
      buckets.set(key, [parts.date, parts.minute, 1, isUser ? 1 : 0])
    }
  }

  if (!meta.start || meta.events < 2) return null
  meta.activity = [...buckets.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
  return meta
}

// ---------- run ----------

const t0 = performance.now()
const claude = claudeFiles()
const codex = codexFiles()
console.log(`scanning ${claude.length} claude files, ${codex.length} codex files since ${SINCE}...`)

const sessions: SessionMeta[] = []
const CONCURRENCY = 8
const queue: [string, "claude" | "codex"][] = [
  ...claude.map((f) => [f, "claude"] as [string, "claude"]),
  ...codex.map((f) => [f, "codex"] as [string, "codex"]),
]
let idx = 0
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (idx < queue.length) {
      const [fp, source] = queue[idx++]
      try {
        const s = await inspect(fp, source)
        if (s) sessions.push(s)
      } catch (e) {
        console.error(`  skip ${fp}: ${e}`)
      }
    }
  }),
)

sessions.sort((a, b) => (a.start! < b.start! ? -1 : 1))

const out = {
  generatedAt: new Date().toISOString(),
  timezone: ZONE,
  since: SINCE,
  transcriptContentIncluded: false,
  sessionCount: sessions.length,
  sessions,
}

mkdirSync(join(OUT, ".."), { recursive: true })
writeFileSync(OUT, JSON.stringify(out))
const secs = ((performance.now() - t0) / 1000).toFixed(1)
const mb = (statSync(OUT).size / 1e6).toFixed(1)
console.log(`wrote ${sessions.length} sessions to ${OUT} (${mb} MB) in ${secs}s`)
