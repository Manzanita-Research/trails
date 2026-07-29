// omp extension — fires the trails rescan when a session shuts down, mirroring
// the Claude/Codex SessionEnd hooks. register once:
//   ln -s "$HOME/code/manzanita-research/trails/scripts/omp-session-end.ts" \
//         "$HOME/.omp/agent/extensions/trails-session-end.ts"
import { spawn } from "node:child_process"
import { basename, dirname, join } from "node:path"

const DETACH = join(import.meta.dir, "session-end-detach.sh")

type ExtensionContext = {
  sessionManager?: { getSessionFile?: () => unknown }
}

// minimal structural type — deliberately no dependency on @oh-my-pi packages
type ExtensionAPI = {
  on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void
}

export default function trailsSessionEnd(pi: ExtensionAPI) {
  pi.on("session_shutdown", (_event, ctx) => {
    try {
      // main sessions live in a flattened-cwd dir ("-code-…"); subagent
      // transcripts live in a dir named after the parent session stem
      // ("2026-…"). only main-session shutdowns should rescan.
      const file = ctx?.sessionManager?.getSessionFile?.()
      if (typeof file === "string" && !basename(dirname(file)).startsWith("-")) return
    } catch {}
    spawn("/bin/sh", [DETACH], { detached: true, stdio: "ignore" }).unref()
  })
}
