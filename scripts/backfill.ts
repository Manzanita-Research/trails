// trails backfill — pulls archived Claude Code sessions back from R2 so the
// scanner can index history that no longer exists on local disk (Claude Code's
// old 30-day cleanup pruned it; records kept copies).
//
// reads the records archiver's state.json for the exact object keys, downloads
// main-session transcripts (subagent files are skipped — trails doesn't index
// them) into ~/.manzanita/trails/backfill/claude/ with the same project-dir
// layout as ~/.claude/projects, and verifies each file against the archiver's
// recorded sha256. no keys: wrangler reads the bucket through its OAuth login.
//
// usage: bun scripts/backfill.ts [--dry]

import { Effect, Schedule } from "effect"
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"

const HOME = homedir()
const STATE = join(HOME, ".config/records/state.json")
const BUCKET = "records-session-logs"
const DEST = join(HOME, ".manzanita/trails/backfill/claude")
const REPO = join(import.meta.dir, "..")
const DRY = process.argv.includes("--dry")

interface Uploaded {
  sha256: string
  size: number
  uploadedAt: string
}

const sha256 = (path: string) =>
  Effect.promise(async () => {
    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(await Bun.file(path).arrayBuffer())
    return hasher.digest("hex")
  })

const download = (key: string, rec: Uploaded) =>
  Effect.gen(function* () {
    // key: sessions/<project-dir>/<session>.jsonl → DEST/<project-dir>/<session>.jsonl
    const relPath = key.slice("sessions/".length)
    const target = join(DEST, relPath)

    if (existsSync(target) && statSync(target).size === rec.size) return "kept"

    mkdirSync(dirname(target), { recursive: true })
    yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          ["bunx", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--file", target, "--remote"],
          { cwd: REPO, stdout: "ignore", stderr: "pipe" },
        )
        const code = await proc.exited
        if (code !== 0) throw new Error(`wrangler exit ${code}: ${await new Response(proc.stderr).text()}`)
      },
      catch: (e) => new Error(`download ${key}: ${e}`),
    })

    const hash = yield* sha256(target)
    if (hash !== rec.sha256) return yield* Effect.fail(new Error(`sha mismatch for ${key}`))
    return "downloaded"
  }).pipe(
    Effect.retry(Schedule.exponential("2 seconds").pipe(Schedule.compose(Schedule.recurs(3)))),
    Effect.timeout("120 seconds"),
  )

const main = Effect.gen(function* () {
  const uploaded: Record<string, Uploaded> = JSON.parse(readFileSync(STATE, "utf8")).uploaded
  const mains = Object.entries(uploaded).filter(
    ([k]) => k.startsWith("sessions/") && k.endsWith(".jsonl") && !k.includes("/subagents/"),
  )
  console.log(`${mains.length} archived main sessions in ${STATE}`)

  if (DRY) {
    for (const [k, r] of mains.slice(0, 10)) console.log(`  ${k} (${(r.size / 1024).toFixed(0)} KB)`)
    console.log(`  … dry run, nothing downloaded`)
    return
  }

  let done = 0
  const results = yield* Effect.forEach(
    mains,
    ([key, rec]) =>
      download(key, rec).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            done++
            if (done % 25 === 0) console.log(`  ${done}/${mains.length}`)
          }),
        ),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            console.error(`  FAILED ${key}: ${e}`)
            return "failed" as const
          }),
        ),
      ),
    { concurrency: 6 },
  )

  const counts = { downloaded: 0, kept: 0, failed: 0 }
  for (const r of results) counts[r as keyof typeof counts]++
  console.log(`downloaded ${counts.downloaded}, already had ${counts.kept}, failed ${counts.failed} → ${DEST}`)
})

await Effect.runPromise(main)
