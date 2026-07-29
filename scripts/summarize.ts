// trails summarizer — turns each scanned session into a one-line contribution
// summary via kimi k3 on workers ai, then joins sessions into per-project day
// summaries. incremental: already-summarized sessions are skipped, so
// rerunning only pays for what's new.
//
// talks to the worker's /api/summarize endpoint, which holds the AI binding —
// no api keys anywhere; `bun run dev` proxies the binding through wrangler's
// oauth login. point TRAILS_WORKER_URL at a deployed worker to run against prod.
//
// usage: bun scripts/summarize.ts [--limit N] [--force] [--dry]

import { Effect, Schedule } from "effect"
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import readline from "node:readline"

const args = process.argv.slice(2)
const LIMIT = (() => {
  const i = args.indexOf("--limit")
  return i >= 0 ? Number(args[i + 1]) : Infinity
})()
const FORCE = args.includes("--force")
const DRY = args.includes("--dry")

const DATA_DIR = join(import.meta.dir, "../public/data")
const SCAN_PATH = join(DATA_DIR, "scan.json")
const OUT_PATH = join(DATA_DIR, "summaries.json")
const BOUNDARY_MIN = 6 * 60

const WORKER_URL = process.env.TRAILS_WORKER_URL ?? "http://localhost:7412"
const MODEL = "@cf/moonshotai/kimi-k2.5" // recorded in the output; the worker owns the actual choice

// ---------- types ----------

interface Session {
  id: string
  source: "claude" | "codex" | "omp" | "pi"
  path: string
  cwd: string | null
  branch: string | null
  start: string
  end: string
  events: number
  userEvents: number
  activity: [string, number, number, number][]
}

type TextBlock = { type?: string; text?: string }

interface Summaries {
  generatedAt: string
  model: string
  sessions: Record<string, string>
  days: Record<string, string>
}

// ---------- digest: bounded extract of a transcript, never the whole log ----------

const clean = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const MAX_USER_MSGS = 20
const MAX_USER_LEN = 400
const MAX_AGENT_LEN = 600
const MAX_DIGEST = 9000

function digestSession(sess: Session): Effect.Effect<string | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      const userMsgs: string[] = []
      let userCount = 0
      const lastAgent: string[] = [] // ring of last 3 assistant messages
      const rl = readline.createInterface({ input: createReadStream(sess.path), crlfDelay: Infinity })
      let lineNo = 0
      let cutoff: string | null = null
      for await (const line of rl) {
        lineNo++
        if (!line) continue
        try {
          if (sess.source === "claude") {
            if (line.includes('"type":"user"') && !line.includes('"toolUseResult"') && !line.includes('"isMeta":true')) {
              const entry = JSON.parse(line)
              const c = entry.message?.content
              const text =
                typeof c === "string"
                  ? c
                  : Array.isArray(c)
                    ? c.find((b: TextBlock) => b.type === "text")?.text
                    : null
              if (text && !text.startsWith("Caveat:") && !text.includes("command-name")) {
                userCount++
                if (userMsgs.length < MAX_USER_MSGS) userMsgs.push(clean(text).slice(0, MAX_USER_LEN))
              }
            } else if (line.includes('"type":"assistant"') && line.includes('"text"')) {
              const entry = JSON.parse(line)
              const text = entry.message?.content?.find?.((b: TextBlock) => b.type === "text")?.text
              if (text) {
                lastAgent.push(clean(text).slice(0, MAX_AGENT_LEN))
                if (lastAgent.length > 3) lastAgent.shift()
              }
            }
          } else if (sess.source === "codex") {
            if (line.includes('"user_message"')) {
              const entry = JSON.parse(line)
              const text = entry.payload?.message
              if (text) {
                userCount++
                if (userMsgs.length < MAX_USER_MSGS) userMsgs.push(clean(text).slice(0, MAX_USER_LEN))
              }
            } else if (line.includes('"agent_message"')) {
              const entry = JSON.parse(line)
              const text = entry.payload?.message
              if (text) {
                lastAgent.push(clean(text).slice(0, MAX_AGENT_LEN))
                if (lastAgent.length > 3) lastAgent.shift()
              }
            }
          } else {
            if (lineNo <= 2 && line.includes('"type":"session"')) {
              const entry = JSON.parse(line)
              if (entry.parentSession) cutoff = entry.timestamp
            }
            if (line.includes('"type":"message"') && line.includes('"role":"user"')) {
              const entry = JSON.parse(line)
              if (cutoff && entry.timestamp < cutoff) continue
              const c = entry.message?.content
              const text =
                typeof c === "string"
                  ? c
                  : Array.isArray(c)
                    ? c.find((b: TextBlock) => b.type === "text")?.text
                    : null
              if (text && !text.startsWith("Caveat:") && !text.includes("command-name")) {
                userCount++
                if (userMsgs.length < MAX_USER_MSGS) userMsgs.push(clean(text).slice(0, MAX_USER_LEN))
              }
            } else if (
              line.includes('"type":"message"') &&
              line.includes('"role":"assistant"') &&
              line.includes('"text"')
            ) {
              const entry = JSON.parse(line)
              if (cutoff && entry.timestamp < cutoff) continue
              const text = entry.message?.content?.find?.((b: TextBlock) => b.type === "text")?.text
              if (text) {
                lastAgent.push(clean(text).slice(0, MAX_AGENT_LEN))
                if (lastAgent.length > 3) lastAgent.shift()
              }
            }
          }
        } catch {}
      }
      if (!userMsgs.length && !lastAgent.length) return null
      const mins = Math.round((new Date(sess.end).getTime() - new Date(sess.start).getTime()) / 60000)
      const parts = [
        `Project: ${sess.cwd ?? "unknown"}${sess.branch ? ` (branch ${sess.branch})` : ""}`,
        `Duration: ~${mins} min, ${userCount} user messages, agent: ${sess.source}`,
        userMsgs.length ? `User messages (in order${userCount > userMsgs.length ? `, first ${userMsgs.length} of ${userCount}` : ""}):\n${userMsgs.map((m) => `- ${m}`).join("\n")}` : "",
        lastAgent.length ? `Agent's closing messages:\n${lastAgent.map((m) => `- ${m}`).join("\n")}` : "",
      ]
      return parts.filter(Boolean).join("\n\n").slice(0, MAX_DIGEST)
    },
    catch: (e) => new Error(`digest ${sess.path}: ${e}`),
  })
}

// ---------- llm ----------

const retryPolicy = Schedule.exponential("2 seconds").pipe(Schedule.intersect(Schedule.recurs(3)))

function chat(system: string, user: string): Effect.Effect<string, Error> {
  return Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(`${WORKER_URL}/api/summarize`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ system, user }),
      })
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
      const body: any = await res.json()
      if (!body.text) throw new Error(`empty completion: ${JSON.stringify(body).slice(0, 300)}`)
      return body.text as string
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  }).pipe(Effect.timeout("120 seconds"), Effect.retry(retryPolicy))
}

const SESSION_SYSTEM = `You summarize coding-agent work sessions for a personal work journal. Reply with one or two plain sentences and nothing else: the core contribution of the session (what was built, changed, investigated, or decided), plus anything left open if it matters. Past tense, specific, compact. No preamble, no bullet points, no quotes around your answer.`

const DAY_SYSTEM = `You join several session summaries from one working day on one project into a single short journal entry. Reply with one or two plain sentences and nothing else: what actually got done that day on this project, folding overlapping sessions together. Past tense, specific, compact.`

// ---------- day grouping (mirrors app.js: 6am boundary, LA-local activity dates) ----------

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function normalizeCwd(cwd: string | null): string {
  if (!cwd) return "(unknown)"
  let p = cwd.replace(/^\/Users\/[^/]+\//, "")
  const wt = p.indexOf("/.claude/worktrees/")
  if (wt >= 0) p = p.slice(0, wt)
  return p
}

function workdaysOf(sess: Session): Set<string> {
  const out = new Set<string>()
  for (const [date, minute] of sess.activity) out.add(minute < BOUNDARY_MIN ? shiftDate(date, -1) : date)
  return out
}

// ---------- main ----------

const program = Effect.gen(function* () {
  const scan = JSON.parse(readFileSync(SCAN_PATH, "utf8"))
  const sessions: Session[] = scan.sessions
  const existing: Summaries = existsSync(OUT_PATH)
    ? JSON.parse(readFileSync(OUT_PATH, "utf8"))
    : { generatedAt: "", model: MODEL, sessions: {}, days: {} }
  if (FORCE) {
    existing.sessions = {}
    existing.days = {}
  }

  const save = () => {
    existing.generatedAt = new Date().toISOString()
    existing.model = MODEL
    writeFileSync(OUT_PATH, JSON.stringify(existing, null, 1))
  }

  const pending = sessions.filter((s) => !existing.sessions[s.id] && existsSync(s.path)).slice(0, LIMIT)
  console.log(`${sessions.length} sessions, ${Object.keys(existing.sessions).length} already summarized, ${pending.length} to do`)

  if (DRY) {
    const first = pending[0]
    if (first) {
      const digest = yield* digestSession(first)
      console.log(`--- digest for ${first.id} (${first.source}) ---\n${digest}`)
    }
    return
  }

  let done = 0
  const newlyTouchedDays = new Set<string>()
  yield* Effect.forEach(
    pending,
    (sess) =>
      Effect.gen(function* () {
        const digest = yield* digestSession(sess)
        if (!digest) return
        const summary = yield* chat(SESSION_SYSTEM, digest)
        existing.sessions[sess.id] = summary
        const project = normalizeCwd(sess.cwd)
        for (const day of workdaysOf(sess)) newlyTouchedDays.add(`${day}|${project}`)
        done++
        if (done % 10 === 0) {
          save()
          console.log(`  ${done}/${pending.length}`)
        }
      }).pipe(
        Effect.catchAll((e) =>
          Effect.sync(() => console.error(`  skip ${sess.id}: ${String(e).slice(0, 200)}`)),
        ),
      ),
    { concurrency: 10 },
  )
  save()
  console.log(`summarized ${done} sessions`)

  // day joins: any project-day whose member set changed, or that's missing
  const dayMembers = new Map<string, string[]>()
  for (const sess of sessions) {
    const summary = existing.sessions[sess.id]
    if (!summary) continue
    const project = normalizeCwd(sess.cwd)
    for (const day of workdaysOf(sess)) {
      const key = `${day}|${project}`
      if (!dayMembers.has(key)) dayMembers.set(key, [])
      dayMembers.get(key)!.push(summary)
    }
  }
  const dayKeys = [...dayMembers.keys()].filter((k) => newlyTouchedDays.has(k) || !existing.days[k])
  console.log(`${dayKeys.length} project-days to join`)

  let joined = 0
  yield* Effect.forEach(
    dayKeys,
    (key) =>
      Effect.gen(function* () {
        const members = dayMembers.get(key)!
        if (members.length === 1) {
          existing.days[key] = members[0]
        } else {
          const [day, project] = [key.slice(0, 10), key.slice(11)]
          existing.days[key] = yield* chat(
            DAY_SYSTEM,
            `Project: ${project}\nDay: ${day}\nSession summaries:\n${members.map((m) => `- ${m}`).join("\n")}`,
          )
        }
        joined++
        if (joined % 20 === 0) save()
      }).pipe(
        Effect.catchAll((e) => Effect.sync(() => console.error(`  skip ${key}: ${String(e).slice(0, 200)}`))),
      ),
    { concurrency: 10 },
  )
  save()
  console.log(`joined ${joined} project-days → ${OUT_PATH}`)
})

await Effect.runPromise(program)
