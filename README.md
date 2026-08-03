# trails

Where your days actually went.

A memory system for parallel, agent-heavy, ADHD-shaped work. Trails is not a time tracker: it reconstructs human-shaped days and active threads from coding-agent session logs already present on your Macs.

## Architecture

One always-on Mac Mini owns the canonical service:

- `trails serve` binds SQLite and the HTTP app to `127.0.0.1:7412`.
- Tailscale Serve exposes that loopback service to the tailnet. Trails never opens a LAN socket and does not add a second application token.
- `trails collect --once` runs every minute on each Mac, parses changed Claude, Codex, omp, and pi transcripts locally, and submits normalized observations in batches of at most 50.
- `~/.manzanita/trails/trails.sqlite` owns sessions, preferences, pocket items, summaries, and durable inference jobs.
- A narrowly scoped Cloudflare Worker authenticates summary requests and calls Workers AI. SQLite remains canonical.

The release artifact is one architecture-specific executable containing the Bun runtime, `bun:sqlite`, and the built React app. Target Macs need neither Bun nor a repository checkout.

## Build

Source and build machines require Bun 1.3.14 or newer.

```bash
bun install --frozen-lockfile
bun run check
bun test
bun run build
```

Outputs:

```text
dist/trails-darwin-arm64
dist/trails-darwin-x64
```

Development runs Vite on 7412 and an API-only Bun server on 7413:

```bash
bun run dev
```

## Configure the Mini

Copy the matching binary to the Mini, then configure the optional inference relay. The token is read from stdin so it does not enter shell history:

```bash
printf '%s\n' "$TRAILS_AI_TOKEN" | trails configure server \
  --ai-url https://trails-ai.example.workers.dev/api/summarize \
  --ai-token-stdin
```

Without `~/.config/trails/server.json`, Trails serves first-prompt fallbacks and leaves summary jobs pending.

Configure the Mini's own collector against loopback:

```bash
trails configure collector --server http://127.0.0.1:7412/ --name "Studio Mini"
```

Preview installation, then install:

```bash
trails install server --dry-run
trails install collector --dry-run
trails install server
trails install collector
```

The server install refuses to proceed without Tailscale. It preserves unrelated Serve handlers and accepts the root only when it is unused or already points exactly to `http://127.0.0.1:7412`.

Installed launchd labels:

- `com.manzanita.trails.server` — loopback service, restarted after failure.
- `com.manzanita.trails.collector` — one collection at load and every 60 seconds; no daemon or keepalive loop.
- `com.manzanita.trails.backup` — a committed SQLite snapshot daily at 03:00, retaining 14 Trails backups.

The UI is available at the HTTPS URL reported by `tailscale serve status`.

## Configure another Mac

Use the Mini's Tailscale HTTPS base URL, whose path must be `/`:

```bash
trails configure collector \
  --server https://studio-mini.example-tailnet.ts.net/ \
  --name "MacBook Pro"
trails collect --once
trails install collector --dry-run
trails install collector
```

The collector identity is created once and preserved across later configuration changes unless `--reset-device-id` is supplied. Changing the endpoint, identity, or display name deliberately replays every discoverable session to the new target. Canonical ingest is idempotent.

For an isolated one-off import, replace all default roots explicitly:

```bash
trails collect --once \
  --server http://127.0.0.1:7412/ \
  --device-id import-machine \
  --device-name "Archive import" \
  --state /tmp/trails-import-state.json \
  --source-root omp=/absolute/path/to/sessions
```

A temporary `--state` path derives its own lock and never touches the default collector state directory.

## Cloudflare inference relay

The Worker exposes only authenticated `POST /api/summarize` requests. Deploy the secret separately from tracked configuration:

```bash
wrangler secret put TRAILS_AI_TOKEN
bun run worker:deploy
```

`wrangler.jsonc` contains only the Worker entrypoint, compatibility date, and Workers AI binding. The model and repository-owned session/day prompts live in `worker/index.ts`; callers cannot supply arbitrary system prompts.

## Backups and restore

Create a manual committed snapshot while the WAL database is active:

```bash
trails backup --output ~/Desktop/trails.sqlite
```

Scheduled form:

```bash
trails backup --output-dir ~/.manzanita/trails/backups --retain 14
```

Restore on the Mini only while the server is stopped:

```bash
launchctl bootout "gui/$UID/com.manzanita.trails.server"
rm -f ~/.manzanita/trails/trails.sqlite-wal ~/.manzanita/trails/trails.sqlite-shm
cp /path/to/trails-backup.sqlite ~/.manzanita/trails/trails.sqlite
chmod 600 ~/.manzanita/trails/trails.sqlite
launchctl bootstrap "gui/$UID" ~/Library/LaunchAgents/com.manzanita.trails.server.plist
launchctl kickstart -k "gui/$UID/com.manzanita.trails.server"
```

Verify a backup independently with `PRAGMA integrity_check` before relying on it.

## Archived transcript backfill

`scripts/backfill.ts` remains an optional R2 restore utility for history archived by [records](https://github.com/manzanita-research/records). It verifies restored objects against recorded SHA-256 values and writes Claude/Codex layouts under `~/.manzanita/trails/backfill/`. The normal collector discovers those roots; live copies win over restored duplicates.

```bash
bun scripts/backfill.ts --dry
bun scripts/backfill.ts
trails collect --once
```

## Remove old session-end hooks

Installation does not edit unrelated agent configuration. Remove the retired full-rescan hooks manually:

1. In `~/.claude/settings.json`, remove the `SessionEnd` command entry whose command contains `scripts/session-end-detach.sh`.
2. In `~/.codex/config.toml`, remove the `[[hooks.SessionEnd]]` entry whose command contains `scripts/session-end-detach.sh`.
3. Remove the omp extension symlink:

   ```bash
   rm ~/.omp/agent/extensions/trails-session-end.ts
   ```

pi never had a Trails hook. The scheduled collector now covers every source.

## Privacy boundary

Transcript parsing happens on the originating Mac. Ingest includes source session ID, source, cwd, branch, timestamps, event counts, first prompt, minute buckets, and a bounded digest. It never sends a transcript path or body. The Mini stores the bounded digest only for summary work; the browser bootstrap receives neither source session IDs nor digests. Inference requests contain at most 9,000 characters for a session or 12,000 characters for a day and are sent only to the configured authenticated relay.
