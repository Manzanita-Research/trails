# Trails

**Where your days actually went.**

Trails turns the coding-agent sessions already on your Macs into a private timeline of projects, working days, and active threads. It is not a time tracker, and there is nothing to start or stop while you work.

> Trails is currently an alpha. Expect rough edges and occasional changes to installation or stored data. Please share failures and confusing behavior with the person who invited you.

## Before you start

You need:

- macOS on every participating computer.
- [Tailscale](https://tailscale.com/download/mac) installed, connected, and signed into the same tailnet on every Mac.
- One Mac that can remain awake, logged in, and connected. This is your **hub**; it owns the Trails database and private web app.

To see data immediately, have existing sessions from one or more supported agents: Claude Code, Codex, omp, or pi. New sessions will also appear after installation.

You do **not** need Bun, Node, a repository checkout, or a public server.

## 1. Set up the hub

Run this on the always-on Mac:

```bash
curl -fsSL https://fancy-cairn-p89p.here.now/install.sh | sh -s -- hub --name "Studio Mini"
```

Replace `Studio Mini` with the name you want Trails to show for that Mac.

Setup downloads the correct binary for your Mac, verifies it, installs the private web service and daily backup, indexes existing sessions, and starts a collector that checks for changes every minute.

When setup finishes, it prints a private Tailscale URL similar to:

```text
https://your-hub.your-tailnet.ts.net/
```

Open that URL from any device on the same tailnet.

## 2. Add another Mac

Run the installer on the other Mac, replacing the example URL with the URL printed by your hub:

```bash
curl -fsSL https://fancy-cairn-p89p.here.now/install.sh | sh -s -- \
  join https://your-hub.your-tailnet.ts.net/ --name "MacBook Pro"
```

The installer verifies the hub before changing local state, indexes sessions already on that Mac, and starts its minute collector. Repeat this step on each additional Mac.

## What happens next

- New and changed sessions normally appear within one minute.
- The hub must remain awake, logged in, connected to Tailscale, and online for collection and the web app to work.
- If the hub is temporarily unavailable, collectors try again on their next scheduled run.
- Trails stores its database at `~/.manzanita/trails/trails.sqlite` on the hub.
- Trails creates a committed SQLite backup every day at 03:00 and keeps the latest 14 under `~/.manzanita/trails/backups/`.
- Generated summaries may be unavailable during the alpha. Trails continues working and uses the first prompt as a fallback.

## Update

Rerun the same installer command you originally used. The binary is replaced atomically; your device identity, configuration, database, and backups are preserved.

Hub:

```bash
curl -fsSL https://fancy-cairn-p89p.here.now/install.sh | sh -s -- hub --name "Studio Mini"
```

Joined Mac:

```bash
curl -fsSL https://fancy-cairn-p89p.here.now/install.sh | sh -s -- \
  join https://your-hub.your-tailnet.ts.net/ --name "MacBook Pro"
```

## Troubleshooting

### `trails` is not found later

The installer always runs setup using the full binary path. For later manual commands, add this line to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### The web app does not open

Confirm that:

1. The hub is awake and logged in.
2. Tailscale says **Connected** on both the hub and the viewing device.
3. Both devices use the same tailnet.
4. You are opening the exact HTTPS URL printed by hub setup.

Rerunning the hub installer is safe and restarts the Trails services.

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

Trails does **not** send transcript paths or transcript bodies to the hub. The web app receives neither source session identifiers nor digests. The hub is reachable only through your tailnet and listens locally on loopback rather than your LAN.

If the optional summary relay is enabled, it receives only bounded summary input—not complete transcripts. Session input is capped at 9,000 characters and day input at 12,000 characters.

## Alpha release

Current version: `0.1.0-alpha.1`

The temporary installer and architecture-specific binaries are hosted at:

**https://fancy-cairn-p89p.here.now/**
