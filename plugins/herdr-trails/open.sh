#!/usr/bin/env bash
set -euo pipefail

HERDR="${HERDR_BIN_PATH:-herdr}"
PLUGIN_ID="${HERDR_PLUGIN_ID:-manzanita.trails}"

if [[ -z "${HERDR_WORKSPACE_ID:-}" ]]; then
  printf 'Trails: open this action from a Herdr workspace\n' >&2
  exit 1
fi

exec "$HERDR" plugin pane open \
  --plugin "$PLUGIN_ID" \
  --entrypoint dashboard \
  --placement tab \
  --workspace "$HERDR_WORKSPACE_ID" \
  --focus
