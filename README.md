# Trails

**Where your days actually went.**

Trails turns the coding-agent sessions already on your Macs into a private timeline of projects, working days, and active threads. It is not a time tracker, and there is nothing to start or stop while you work.

> Trails is currently an alpha. Expect rough edges and occasional changes to installation or stored data. Please share failures and confusing behavior with the person who invited you.

## Before you start

You need macOS and a Terminal. To see data immediately, have existing sessions from Claude Code, Codex, omp, or pi; new sessions will also appear after installation.

You do **not** need a second Mac, Tailscale, Bun, Node, a repository checkout, or a public server.

## Start with one Mac

Run:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- hub --name "Home Mac"
```

Replace `Home Mac` with the name you want Trails to show for that computer.

That one Mac runs the complete system: the private web app and database, its own session collector, and daily backups. Trails calls it the **hub** because it owns the canonical data—not because it must be a separate server.

Setup downloads the correct binary, verifies it, indexes existing sessions, and starts a collector that checks for changes every minute. When it finishes, open:

**http://127.0.0.1:7412/**

## Add other Macs (optional)

Only multi-Mac setups need Tailscale. Install [Tailscale](https://tailscale.com/download/mac), connect every participating Mac to the same tailnet, then rerun hub setup with private network access enabled:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- \
  hub --tailscale --name "Home Mac"
```

The hub prints a private HTTPS URL similar to:

```text
https://your-hub.your-tailnet.ts.net/
```

Run the installer on each additional Mac—each a **spoke**—using that URL:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- \
  join https://your-hub.your-tailnet.ts.net/ --name "Laptop"
```

Each spoke parses its own sessions locally and sends normalized observations to the hub every minute. The hub continues collecting its own sessions too; clients and servers are roles within the same Trails binary, not separate products or required machines.

### Optional stable `trails` address

By default, a multi-Mac URL follows the hub machine's MagicDNS name. Tailnet administrators can instead define a [Tailscale Service](https://tailscale.com/docs/features/tailscale-services) named `trails`, keeping the address stable if Trails later moves to another hub:

```text
https://trails.your-tailnet.ts.net/
```

Tailscale Services require a pre-defined `svc:trails` service, a tag-authenticated hub, and service-host approval. After those prerequisites are complete, use:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- \
  hub --service svc:trails --name "Home Mac"
```

## What happens next

- New and changed sessions normally appear within one minute.
- The hub must remain awake and logged in while you use Trails. Multi-Mac collection also requires the hub to remain connected to Tailscale.
- If a multi-Mac hub is temporarily unavailable, spokes try again on their next scheduled run.
- Trails stores its database at `~/.manzanita/trails/trails.sqlite` on the hub.
- Trails creates a committed SQLite backup every day at 03:00 and keeps the latest 14 under `~/.manzanita/trails/backups/`.
- Generated summaries may be unavailable during the alpha. Trails continues working and uses the first prompt as a fallback.

## Update

Rerun the same installer command you originally used. The binary is replaced atomically; your device identity, configuration, database, and backups are preserved. Keep `--tailscale` or `--service svc:trails` in the hub command if you use that mode.

## Troubleshooting

### `trails` is not found later

The installer always runs setup using the full binary path. For later manual commands, add this line to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### The web app does not open

For one Mac, confirm the hub is awake and logged in, then open **http://127.0.0.1:7412/** on that Mac.

For multiple Macs, also confirm that Tailscale says **Connected** on the hub and viewing device, both use the same tailnet, and you are opening the exact HTTPS URL printed by `--tailscale` or `--service` setup.

Rerunning the original hub installer command is safe and restarts the Trails services.

### Setup fails

Rerun the same command once. If it still fails, send the command output and the relevant error log to the person who invited you:

```text
~/.local/state/trails/com.manzanita.trails.server.error.log
~/.local/state/trails/com.manzanita.trails.collector.error.log
~/.local/state/trails/com.manzanita.trails.backup.error.log
```

Only the hub has server and backup logs.

## Privacy

Transcript parsing happens on the Mac where each session was created. Trails sends the hub only normalized observations: source, session identifier, working directory, branch, timestamps, event counts, first prompt, minute activity, and a bounded digest.

Trails does **not** send transcript paths or transcript bodies to the hub. The web app receives neither source session identifiers nor digests. The hub service listens only on loopback; optional Tailscale Serve access exposes it privately to the tailnet rather than the LAN or public internet.

If the optional summary relay is enabled, it receives only bounded summary input—not complete transcripts. Session input is capped at 9,000 characters and day input at 12,000 characters.

## Alpha release

Current version: `0.1.0-alpha.5`

The stable installer URL is:

**https://releases.manzanita.dev/trails/install.sh**

It follows the recommended `alpha` channel. The installer downloads the matching macOS binary from an immutable versioned path and verifies its pinned SHA-256 before replacing `~/.local/bin/trails`. Release metadata and checksums are public at:

```text
https://releases.manzanita.dev/trails/channels/alpha.json
https://releases.manzanita.dev/trails/releases/0.1.0-alpha.5/release.json
https://releases.manzanita.dev/trails/releases/0.1.0-alpha.5/SHA256SUMS
```

## Release operations

Trails owns compilation, its installer, version selection, and a validated staging directory. The shared [`Manzanita-Research/releases`](https://github.com/Manzanita-Research/releases) repository owns immutable R2 storage, manifest validation, upload ordering, public verification, channel promotion/rollback, and `releases.manzanita.dev`.

Build the production web app, standalone binaries, installer, checksums, and release descriptor:

```sh
bun install --frozen-lockfile
bun run release:stage
```

This writes:

```text
dist/release/trails/<version>/
```

Validate through the shared publisher before uploading:

```sh
cd /path/to/releases
bun install --frozen-lockfile
bun run publish -- \
  --from /absolute/path/to/trails/dist/release/trails/<version> \
  --channel alpha \
  --dry-run
```

Remove `--dry-run` to publish. The shared publisher validates locally, refuses immutable collisions, uploads versioned binaries, verifies their public bytes and hashes, uploads checksums/installer/release metadata, verifies every versioned URL, then updates the alpha channel and stable installer last. A partial upload never becomes current.

Promotion and rollback point the mutable channel and bootstrap installer at an already verified immutable version:

```sh
bun run promote -- \
  --product trails \
  --version <already-published-version> \
  --channel alpha \
  --dry-run
```

Remove `--dry-run` after review. Selecting an older version performs a rollback; versioned artifacts are never mutated or deleted.
