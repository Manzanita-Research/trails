// trails scanner — walks local Claude Code + Codex session logs and emits
// metadata-only JSON (no transcript content beyond a short first-prompt snippet).
//
// usage: bun scripts/scan.ts [--since 2026-06-22] [--out public/data/scan.json]

import {
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  createReadStream,
  openSync,
  readSync,
  closeSync,
} from "node:fs"
import { join, sep, basename, relative } from "node:path"
import { homedir } from "node:os"
import readline from "node:readline"

const HOME = homedir()
const CLAUDE_ROOT = join(HOME, ".claude/projects")
// sessions restored from the records R2 archive (scripts/backfill.ts) — same
// layouts as the live roots; predates the live logs, so the --since filter is skipped
const BACKFILL_CLAUDE = join(HOME, ".manzanita/trails/backfill/claude")
const BACKFILL_CODEX = join(HOME, ".manzanita/trails/backfill/codex")
const CODEX_ROOT = join(HOME, ".codex/sessions")
const ZONE = "America/Los_Angeles"

const args = process.argv.slice(2)
const argVal = (flag: string, fallback: string) => {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const SINCE = argVal("--since", "2026-06-22")
const OUT = argVal("--out", join(import.meta.dir, "../public/data/scan.json"))
const sinceMs = new Date(`${SINCE}T00:00:00-07:00`).getTime()

// ---------- discovery ----------

function claudeFiles(root: string, skipSince = false): string[] {
  const files: string[] = []
  let projectDirs: string[] = []
  try {
    projectDirs = readdirSync(root)
  } catch {
    return files
  }
  for (const dir of projectDirs) {
    // CodexBar's automated /usage probe sessions are noise, not work
    if (dir.endsWith("-Library-Application-Support-CodexBar-ClaudeProbe")) continue
    const full = join(root, dir)
    let entries: string[] = []
    try {
      entries = readdirSync(full)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue // skips subagent dirs too
      if (name.startsWith("agent-")) continue // old flat-layout subagent transcripts
      const fp = join(full, name)
      try {
        if (skipSince || statSync(fp).mtimeMs >= sinceMs) files.push(fp)
      } catch {}
    }
  }
  return files
}

function codexFiles(root: string, skipSince = false): string[] {
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
        const rel = relative(root, full)
        const datePart = rel.split(sep).slice(0, 3).join("/")
        if (skipSince || datePart >= sinceDate) files.push(full)
      }
    }
  }
  visit(root)
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
  // absolute path to the source jsonl, so the summarizer can reread it without re-discovery
  path: string
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
    path: filePath,
    cwd: null,
    branch: null,
    start: null,
    end: null,
    events: 0,
    userEvents: 0,
    firstPrompt: null,
    activity: [],
  }

  // pre-mid-2026 codex stored subagent rollouts flat beside real sessions — the
  // session_meta on line 1 is the only reliable tell. peek it cheaply up front:
  // bailing out mid-stream leaks the readline pipeline and tanks the whole scan.
  if (source === "codex") {
    const fd = openSync(filePath, "r")
    const buf = Buffer.alloc(131072)
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const head = buf.toString("utf8", 0, n)
    const nl = head.indexOf("\n")
    const first = nl >= 0 ? head.slice(0, nl) : head
    if (first.includes('"thread_source":"subagent"')) return null
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
const claude = claudeFiles(CLAUDE_ROOT)
const codex = codexFiles(CODEX_ROOT)
// a session can exist both live and backfilled — the live copy wins
const liveClaude = new Set(claude.map((f) => basename(f)))
const liveCodex = new Set(codex.map((f) => basename(f)))
const backClaude = claudeFiles(BACKFILL_CLAUDE, true).filter((f) => !liveClaude.has(basename(f)))
const backCodex = codexFiles(BACKFILL_CODEX, true).filter((f) => !liveCodex.has(basename(f)))
console.log(
  `scanning ${claude.length} claude files (+${backClaude.length} backfilled), ${codex.length} codex files (+${backCodex.length} backfilled) since ${SINCE}...`,
)

const sessions: SessionMeta[] = []
const CONCURRENCY = 8
const queue: [string, "claude" | "codex"][] = [
  ...claude.map((f) => [f, "claude"] as [string, "claude"]),
  ...backClaude.map((f) => [f, "claude"] as [string, "claude"]),
  ...codex.map((f) => [f, "codex"] as [string, "codex"]),
  ...backCodex.map((f) => [f, "codex"] as [string, "codex"]),
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
