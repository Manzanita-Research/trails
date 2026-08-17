#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

mkdir -p dist
bun build --compile --minify --outfile dist/trails-herdr src/main.ts
