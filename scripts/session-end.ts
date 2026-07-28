// fired (detached) by the global SessionEnd hook — rescans the session logs so
// trails stays current without anyone remembering to run `bun run scan`. if the
// dev server is up it also summarizes whatever's new; otherwise summaries catch
// up the next time a session ends while the server is running.
//
// sessions end in bursts (parallel agent work), so runs are serialized with a
// lockfile: latecomers drop a rerun flag and exit, and the holder loops until
// the flag stops appearing.

import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const LOCK = join(ROOT, ".hook.lock")
const RERUN = join(ROOT, ".hook.rerun")

const takeLock = (): boolean => {
  try {
    mkdirSync(LOCK)
    return true
  } catch {
    try {
      // a killed run can strand the lock — steal it once it's clearly stale
      if (Date.now() - statSync(LOCK).mtimeMs < 15 * 60_000) return false
      rmSync(LOCK, { recursive: true, force: true })
      mkdirSync(LOCK)
      return true
    } catch {
      return false
    }
  }
}

const run = (script: string) =>
  spawnSync(process.execPath, [join(ROOT, "scripts", script)], { cwd: ROOT, stdio: "inherit" })

// any response (even a 400 to this junk body) proves the worker is reachable
const workerUp = async (): Promise<boolean> => {
  try {
    await fetch("http://localhost:7412/api/summarize", {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(3000),
    })
    return true
  } catch {
    return false
  }
}

if (!takeLock()) {
  writeFileSync(RERUN, "")
  process.exit(0)
}

try {
  do {
    rmSync(RERUN, { force: true })
    console.log(`[${new Date().toISOString()}] session ended — rescanning`)
    run("scan.ts")
    if (await workerUp()) run("summarize.ts")
    else console.log("dev server down — summaries will catch up next time it's up")
  } while (existsSync(RERUN))
} finally {
  rmSync(LOCK, { recursive: true, force: true })
}
