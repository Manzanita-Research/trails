#!/usr/bin/env bash
# Minimal repro: Workers RPC into a Durable Object whose constructor returns a
# Proxy (what alchemy's DurableObjectBridge does). Run after ../../run.sh has
# fetched celld and installed workerd. Prints one line per class per runtime.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
spike="$here/../.."
work="$spike/state/probe-proxy-rpc"
rm -rf "$work" && mkdir -p "$work/disk"
cp "$here"/index.js "$here"/wrangler.json "$here"/config.capnp "$work/"

probe() {
  for class in NoCtor CtorOnly CtorBcw Proxied; do
    printf '%s %-8s ' "$1" "$class"
    curl -s -m 8 "http://127.0.0.1:$2/$class" || echo "(no answer in 8 s)"
    echo
  done
}

"$spike/.bin/celld" dev "$work/wrangler.json" --port 8796 --no-watch > "$work/celld.log" 2>&1 &
celld=$!
until grep -q "ready  http" "$work/celld.log"; do sleep 0.2; done
probe celld 8796
# celld dev runs its node as a child in its own session: stop both.
{ pkill -9 -P "$celld"; kill -9 "$celld"; wait "$celld"; } 2>/dev/null || true

workerd="$(cd "$spike/node_modules/workerd" && node -p "require.resolve('@cloudflare/workerd-darwin-arm64/bin/workerd')")"
"$workerd" serve "$work/config.capnp" --socket-addr http=127.0.0.1:8797 --directory-path "disk=$work/disk" > "$work/workerd.log" 2>&1 &
pid=$!
until curl -s -o /dev/null http://127.0.0.1:8797/NoCtor; do sleep 0.2; done
probe workerd 8797
{ kill "$pid"; wait "$pid"; } 2>/dev/null || true
