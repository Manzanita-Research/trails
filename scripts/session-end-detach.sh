#!/bin/sh
# hook entrypoint for both Claude Code and Codex — detaches the real runner
# immediately so session close never waits on the ~40s rescan (Codex caps
# SessionEnd hooks at 3 seconds).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
nohup "$HOME/.bun/bin/bun" "$DIR/scripts/session-end.ts" >> "$DIR/.hook.log" 2>&1 < /dev/null &
exit 0
