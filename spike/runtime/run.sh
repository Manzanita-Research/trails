#!/usr/bin/env bash
# Phase 0 runtime spike, end to end: alchemy/Domain (the bank) on celld dev
# (Route A) and workerd (Route C), on loopback, one runtime at a time.
#
#   ./run.sh                       # the pinned celld (celld.lock.json)
#   CELLD_VERSION=v0.6.3 CELLD_SHA256=<sha256 of the .gz> ./run.sh
#   SHIMS=terminal ./run.sh        # re-test with fewer workarounds
#
# Apple Silicon macOS only (celld ships no Intel Mac build). Needs node >= 22.18
# and pnpm. Nothing is installed outside this directory; state goes to ./state.
set -euo pipefail
cd "$(dirname "$0")"

[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { echo "celld dev needs Apple Silicon macOS" >&2; exit 1; }

lock() { node -e "console.log(require('./celld.lock.json').$1)"; }
CELLD_VERSION="${CELLD_VERSION:-$(lock version)}"
CELLD_SHA256="${CELLD_SHA256:-$(lock sha256)}"
SHIMS="${SHIMS:-terminal,rpc}"
COMMANDS="${COMMANDS:-400}"
CUSTOMERS="${CUSTOMERS:-10}"
RESULTS="${RESULTS:-results}"

echo "== install"
[ -d node_modules ] || pnpm install --frozen-lockfile

echo "== celld $CELLD_VERSION"
asset="celld-aarch64-apple-darwin.gz"
bin=".bin/celld-$CELLD_VERSION"
if [ ! -x "$bin" ]; then
  mkdir -p .bin
  curl -fsSL -o ".bin/$asset" "https://github.com/denoland/celld/releases/download/$CELLD_VERSION/$asset"
  echo "$CELLD_SHA256  .bin/$asset" | shasum -a 256 -c -
  gunzip -c ".bin/$asset" > "$bin"
  chmod +x "$bin"
  rm ".bin/$asset"
fi
ln -sf "celld-$CELLD_VERSION" .bin/celld
.bin/celld --version 2>/dev/null

echo "== build"
node build.ts --out dist/as-built
node build.ts --shims terminal --out dist/terminal-only
node build.ts --shims "$SHIMS" --out dist/shimmed

echo "== does the bundle alchemy builds serve as is?"
mkdir -p "$RESULTS"
node driver/spike.ts --route celld --bundle dist/as-built --smoke --out "$RESULTS/celld-as-built.json" || true
node driver/spike.ts --route celld --bundle dist/terminal-only --smoke --out "$RESULTS/celld-terminal-only.json" || true
node driver/spike.ts --route workerd --bundle dist/as-built --smoke --out "$RESULTS/workerd-as-built.json" || true

echo "== full runs (shims: $SHIMS), one runtime at a time"
node driver/spike.ts --route celld --bundle dist/shimmed --commands "$COMMANDS" --customers "$CUSTOMERS" --out "$RESULTS/celld.json" || true
node driver/spike.ts --route workerd --bundle dist/shimmed --commands "$COMMANDS" --customers "$CUSTOMERS" --out "$RESULTS/workerd.json" || true

echo "== report"
node driver/report.ts "$RESULTS" | tee "$RESULTS/summary.md"
