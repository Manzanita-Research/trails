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

Run `trails auth owner` on the hub and paste the credential into the sign-in screen. The owner credential stays on the hub; each additional collector gets its own credential.

## Add other Macs (optional)

Only multi-Mac setups need Tailscale: for example, you can use a Mac Mini as a hub with laptops as spokes. Install [Tailscale](https://tailscale.com/download/mac), connect every participating Mac to the same tailnet, then rerun hub setup with private network access enabled:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- \
  hub --tailscale --name "Home Mac"
```

The hub prints a private HTTPS URL similar to:

```text
https://your-hub.your-tailnet.ts.net/
```

On the hub, create a separate pairing file for each additional Mac:

```bash
trails auth pair --server https://your-hub.your-tailnet.ts.net/ --name "Laptop" --output ~/.config/trails/pairing.json
```

Transfer that file privately to `~/.config/trails/pairing.json` on the additional Mac (directory mode `700`, file mode `600`), then run the installer there using the same URL:

```bash
curl -fsSL https://releases.manzanita.dev/trails/install.sh | sh -s -- \
  join https://your-hub.your-tailnet.ts.net/ --pairing-file ~/.config/trails/pairing.json
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
- Summaries are optional and stay off until you explicitly choose an installed harness on the hub.
- Open **settings** in the web app to choose the day boundary, attention halo, IANA time zone, and summary harness. The same screen shows collector and harness freshness.

## View Trails in Herdr

The Herdr plugin is a terminal-native, read-only view of Trails: recent days, a seven-workday overview, project threads, collector freshness, and summary-harness health. It automatically reads the server URL from the existing `~/.config/trails/collector.json` without modifying that file. If the tailnet is unavailable, the pane stays usable, reports the offline state, and retries every 30 seconds; reconnecting Tailscale is enough to bring it back.

During local development, build and link the plugin from this checkout:

```bash
bun run herdr:build
herdr plugin link ./plugins/herdr-trails
herdr plugin action invoke open --plugin manzanita.trails
```

Use `1`–`4` to switch between days, week, threads, and status; `j`/`k` to move; `enter` to open details; `r` to refresh; and `q` to close the pane.

The fixture server is loopback-only and never reads or writes the installed Trails database or client configuration:

```bash
bun run herdr:fixture
TRAILS_HERDR_SERVER_URL=http://127.0.0.1:7414/ \
  plugins/herdr-trails/dist/trails-herdr --snapshot
```

`TRAILS_HERDR_SERVER_URL` is an ephemeral override for development. A durable plugin-only override may instead be stored as `{"server":"https://…"}` in `config.json` under the directory printed by `herdr plugin config-dir manzanita.trails`; this also leaves the Trails collector configuration untouched.

## View Trails in BB

The BB plugin adds a **Trails** sidebar page with working days, project sessions, and collector/summary health, plus `bb trails` commands and a `trails_query` agent tool. It reads the existing connection on an enrolled BB machine, so the browser and BB server do not need direct access to the hub.

```sh
cd plugins/bb-plugin-trails
npm ci --include=dev
bb plugin build
bb plugin install . --yes
```

Open **Trails** in BB and choose the machine with your collector configuration. In a project thread, choose **Trails** from the right panel's new-tab launcher for repository-scoped sessions grouped by workday, with day summaries and known worktrees included. Commands inside a BB thread use that thread's machine:

```sh
bb trails days --limit 7
bb trails projects --date 2026-09-16 --json
bb trails status
```

The plugin is read-only. Activity queries include private project names, paths, first prompts, and summaries in BB; agent queries also include them in the conversation. Full transcripts, digests, source session identifiers, and capture payloads are excluded. See [the plugin README](plugins/bb-plugin-trails/README.md) for machine selection, connection overrides, pagination, and development checks.

## Optional summaries

The hub can summarize bounded session and day digests through a coding harness already installed and authenticated on that Mac. Collectors never need AI credentials. Trails supports:

- **Oh My Pi (`omp`)**
- **Claude Code (`claude`)**
- **Codex (`codex`)**
- **OpenCode (`opencode`)**
- **Pi (`pi`)**

Open **settings → summarization** on the hub and choose one harness. **Automatic** uses the first installed harness in the order above. Trails invokes the CLI non-interactively in a fresh temporary directory, disables tool access and session persistence with each harness's native controls, and removes temporary input/output files after every call.

The same controls are available from the hub terminal:

```bash
trails summaries status
trails summaries use auto
trails summaries use codex
trails summaries off
```

The harness owns its login, provider, model, and billing. Trails never reads, copies, refreshes, or stores harness credentials. Harness authentication failures, provider quota limits, malformed responses, timeouts, and harness failures leave jobs durable. Eligible jobs retry with backoff up to five failed attempts; a failed request is never resent through a different harness automatically. The resource limits below apply backpressure to collection when storage, queue, or admission budgets are exhausted. Upgrading from alpha.7 removes the retired Trails-owned credential file after validating it; revoke the former OpenRouter, OpenAI, or ChatGPT grant in that provider account because deleting the local copy cannot revoke a remote credential.

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

Collector HTTP requests have a 15-second deadline, including response reads, and each collection cycle has a two-minute deadline covering parsing, uploads, retry waits, and status reporting. Upload acknowledgments are limited to 8 KiB and must account for every session in the batch before it is checkpointed. A timeout releases the collector lock so the next scheduled cycle can retry uncheckpointed work; an atomic checkpoint already being written finishes before the lock is released.

## Privacy

Transcript parsing happens on the Mac where each session was created. Trails sends the hub only normalized observations: source, session identifier, working directory, branch, timestamps, event counts, first prompt, minute activity, and a bounded digest.

Trails does **not** send transcript paths or transcript bodies to the hub. The web app receives neither source session identifiers nor digests. The hub service listens only on loopback; optional Tailscale Serve access exposes it privately to the tailnet rather than the LAN or public internet.

The hub rejects HTTP authorities outside its configured allowlist before serving any API or web content. Local access allows `127.0.0.1`, `localhost`, and `[::1]` at the selected port. Tailscale setup records the exact node or service HTTPS origin in the server LaunchAgent. Rerun setup with the same exposure options after upgrading an older installation or changing its Tailscale name. For manual source-mode serving, repeat `--trusted-origin https://hub.example.ts.net` for each public origin; wildcard hosts are not supported. Proxies must preserve Host; forwarding headers do not establish trust.

Browser mutations require a matching origin when Origin is present and reject cross-site or same-site Fetch Metadata. Native collectors without browser headers remain supported. These checks defend the HTTP/browser boundary; the application credentials below authenticate local processes and tailnet peers. `bun run dev` explicitly allows the local Vite origin at port 7412 and keeps its Host when proxying to the API on port 7413.

The private web UI prohibits framing, including by the same origin, with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. This applies to disk and embedded static responses and the Vite development server. Open Trails as a top-level page on loopback or its trusted tailnet origin. The BB integration renders its own UI through authenticated JSON API reads and requires no framing exception.

### Authentication and upgrading an existing hub

Trails is a single-owner service on loopback or a private tailnet. Network reachability does not grant access. The public health response contains only `{ "ok": true }`; the sign-in page and its assets contain no timeline data. All timeline, machine, image, and harness reads require credentials.

| Credential | Permission |
| --- | --- |
| Owner | Read data and change settings, pocket state, projects, and summary harness selection |
| Read | Read APIs only; intended for BB, Herdr, and other integrations |
| Collector | Upload sessions/captures and report status for its paired device ID only |

Owner and read credentials cannot ingest. Collectors cannot read the timeline, enumerate machines, change settings, or activate paid/provider-backed summaries. Native clients send `Authorization: Bearer TOKEN`; URL parameters are not credentials. Use HTTPS for tailnet traffic. HTTP is supported only on loopback.

On first startup, the hub creates a random owner credential in `trails.sqlite.owner-token` beside its database, with mode 0600. No HTTP endpoint can claim ownership. `trails auth owner` prints the credential only when explicitly run from the hub account. Add `--db PATH` when using a custom database. The browser exchanges it for a 12-hour, HttpOnly, SameSite=Strict cookie, with Secure required for configured HTTPS authorities. Sign out removes that session; restarting the hub expires browser sessions. Credentials are hashed in SQLite and checked on every request.

After updating an existing installation:

1. Rerun `trails setup hub` on the hub, retaining its original `--tailscale` or `--service svc:NAME` option. This keeps its device ID and provisions its local collector. Existing data and summary selection remain intact. A manually started hub can use `trails serve` to initialize owner authentication without installing services.
2. Sign in using `trails auth owner`. Unauthenticated requests now return 401; there is no legacy anonymous mode.
3. For each remote collector, read its existing `deviceId` from `~/.config/trails/collector.json`. On the hub, run `trails auth pair --server HUB_URL --device-id EXISTING_ID --name NAME --output ~/.config/trails/pairing.json`. Transfer the file privately and run `trails setup join HUB_URL --pairing-file ~/.config/trails/pairing.json` on that collector. Using its existing ID preserves session history and progress. Pairing files are bearer credentials, not public invitation links; delete transferred copies after import. Use a fresh credential per device. Legacy collector configuration must be owned by the collector account and mode 0600 (`chmod 600 ~/.config/trails/collector.json`).
4. For each read integration, run `trails auth read --server HUB_URL --output ~/.config/trails/reader.json` on the hub. Transfer it privately to that integration's host account and install it at `~/.config/trails/reader.json` with mode 0600. Both BB and Herdr read this file, independently of collector credentials, and refuse to send it to a different hub URL. Use `http://127.0.0.1:7412/` for a local integration. Server URL changes require a matching reader configuration.

Run `trails auth list` on the hub to see credential IDs and device bindings without exposing tokens. `trails auth revoke CREDENTIAL_ID` immediately revokes a collector or read credential without deleting history; revoke every credential listed for a device when unpairing it. To replace a revoked credential, issue and import a new pairing/read file. `trails auth rotate-owner` replaces the owner credential and revokes all browser sessions, including when the owner token file was lost. It does not revoke collectors or read integrations. These administrative commands require access to the hub account and database; keep credential files and database backups private. Processes running as that same OS account remain inside the owner trust boundary.

When you explicitly activate a summary harness, the provider already configured in that harness receives only the bounded digest input and Trails-owned system prompt needed for the selected job—not complete transcripts, source files, database contents, collector traffic, or unrelated environment values. Session input is capped at 9,000 characters and day input at 12,000 characters.

Trails checks private files and their parent directories before use. Configuration, credentials, collector state, databases (including SQLite sidecars), logs, and backups must be regular files owned by the running account with no group/other access, normally mode `600`. Their immediate directories must be owned by that account with mode `700`. Ancestors may be searchable by others but cannot be group/other-writable or owned by another non-root account. Root-owned sticky temporary directories and root-owned system directory aliases such as macOS `/tmp` are supported; user-created directory symlinks, file symlinks, and hardlinked private files are rejected.

Existing safe files upgrade normally. Unsafe paths fail with the offending path and repair guidance; Trails does not silently chmod or take ownership of existing data. Stop the affected Trails service, inspect the reported path and its ownership, and remove unintended group/other permissions only after confirming it is your intended file or directory. Store exported pairing credentials inside an owner-only directory too. These checks protect against other local accounts with access through unsafe filesystem permissions. They do not isolate processes running as the same OS account; SQLite and launchd still open validated paths by name.

Harness selection lives in owner-only `~/.config/trails/server.json`. Harness credentials remain owned by the harness and never enter Trails configuration, SQLite, collector traffic, browser responses, feedback, or logs. Browser-visible status is limited to harness availability, selection, attempt/success timestamps, and a closed actionable error class.

Sending beta feedback is explicit. The browser sends only the feedback kind, message, optional follow-up, and creation time unless you opt in to safe context. Safe context is limited to the trails version, current view, canonical revision, selected work date on Days or Project, counts by Claude Code/Codex/omp/pi source, viewport dimensions, and whether synchronization is in an error state. It never includes URLs or tailnet details, device or project names, paths, branches, prompts, summaries, identifiers, digests, transcript content, or user-agent.

Feedback goes directly from the browser to a separate public-write Cloudflare Worker and D1 database with no public read route. It expires after 90 days and is deleted by the next daily cleanup. Cloudflare does not provide Trails inference; canonical session and organization state remains in SQLite on the hub Mac.

### HTTP cache policy

All API JSON, status responses (including unchanged-bootstrap 204s), authentication responses, and errors use `Cache-Control: no-store`. Private capture images use the same zero-retention policy on GET, HEAD, and conditional 304 responses. Browsers and proxies must not store these responses for reuse; images are deliberately fetched again instead of receiving a freshness window or offline fallback. Authentication and image existence are checked before evaluating an ETag, so the next request after session/credential revocation or image removal returns an error even with a matching validator.

Bootstrap image URLs use a `v=2-` prefix to bypass entries stored under the former one-year immutable image policy. Updating the server cannot purge those older entries from browsers that already have them; clear the site's cached data on previously used clients when upgrading. HTTP cache policy also cannot erase downloaded files, screenshots, or content already rendered in an open page. Revocation governs subsequent requests, not copies already delivered.

Only nonprivate, fingerprinted static assets receive `public, max-age=31536000, immutable`. The HTML shell and SPA fallbacks use `no-store`; other static assets use `no-cache` and must revalidate.

Run the HTTP regressions with `bun test test/cache-policy.test.ts test/server.test.ts test/auth.test.ts`. The standalone browser probe, `bun --no-install scripts/check-cache-policy-browser.ts`, uses an existing Playwright installation (set `PLAYWRIGHT_MODULE` to its module path if it is outside this checkout). It starts only a temporary loopback fixture, uses a fresh browser profile with caching enabled, and removes its temporary files. It checks repeated requests, conditional requests, logout, deletion, offline behavior, legacy URL migration, and public asset caching without accessing an installed hub.

## Alpha release

Current version: `0.1.0-alpha.11`

The stable installer URL is:

**https://releases.manzanita.dev/trails/install.sh**

It follows the recommended `alpha` channel. The installer downloads the matching macOS binary from an immutable versioned path and verifies its pinned SHA-256 before replacing `~/.local/bin/trails`. Release metadata and checksums are public at:

```text
https://releases.manzanita.dev/trails/channels/alpha.json
https://releases.manzanita.dev/trails/releases/0.1.0-alpha.11/release.json
https://releases.manzanita.dev/trails/releases/0.1.0-alpha.11/SHA256SUMS
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

Staging rejects non-executable or wrong-architecture Mach-O files, symlinks and special files, unexpected client assets or embedded modules, source maps/bytecode, invalid installer syntax, descriptor mismatches, and recognized private payload patterns. `scripts/release-audit.ts` defines the explicit asset and privacy policy. The native Bun module format is inspected statically for both architectures; an unfamiliar format fails closed and requires policy review when upgrading Bun.

Each staging directory also contains `release-audit.json`: a deterministic local review artifact with the policy hash, asset inventory, embedded module inventory, and staged file sizes/hashes. It contains no timestamps, operator paths, environment values, or matched private text. Recheck the staged bytes against that report and the current client build without recompiling:

```sh
bun scripts/stage-release.ts --audit dist/release/trails/<version>
```

The audit report stays local; the shared publisher's transport contract is unchanged. Keep it with the release review evidence. Pattern checks cover credential formats, sensitive environment values, personal paths, private endpoints, transcript/digest fixtures, source history, and source maps. Known Bun CI source paths have a narrow native-runtime exception, never an exception in the product module graph. These checks cannot prove that arbitrary or encoded secrets are absent. Review policy changes and audit findings before publication. A local validation build does not reserve a version: select a fresh version before publishing changed bytes.

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

### Resource limits and full-storage recovery

The hub bounds each ingest request to 5 MiB, 50 sessions or 20 captures, 2,048
activity/attention tuples per record and 4,096 tuples per batch. Session and
capture intervals and their activity spans may cover at most 31 days. The
collector splits uploads by both session count and tuple count; an individually
oversized session remains uncheckpointed and requires correction at the source.
Authenticated ingest, capture and collector-status requests share a device limit
of 30 requests per minute and one active request. The hub allows 120 such
requests per minute, four active readers, and ten seconds to receive a body.
Health requests do not consume these limits. Rate windows reset on hub restart.

Storage admission is atomic across a batch, with these combined session/capture
ceilings:

| Resource | Per device | Whole hub |
| --- | ---: | ---: |
| Records | 5,000 | 10,000 |
| Activity and attention tuples | 50,000 | 100,000 |
| Decoded image bytes | 128 MiB | 512 MiB |
| Pending session and day summary jobs | 200 | 1,000 |
| Changed sessions admitted per 24 hours | 200 | 1,000 |
| Paid summary attempts per 24 hours | 100 | 300 |

A project's pending day jobs count against every device contributing sessions to
that project. Paid day summaries charge each contributing device, as well as the
hub. Admission and attempt budgets persist across restarts in 24-hour windows
starting at first use; retries and failed provider calls consume attempts.
These are call budgets, not currency guarantees: pricing remains controlled by
the selected harness/provider. Jobs stop retrying after five failed attempts;
a new digest or day generation can replace that failed job within the same
admission limits. Single-session day summaries are copied without a paid call.
The derived day-summary cache retains its newest 10,000 entries.

Changed ingests check a 256 MiB free-disk reserve. SQLite is limited to 1 GiB
(or its existing size if already larger); WAL checkpointing remains enabled,
with a 16 MiB retained-journal target. These are application limits, not a
filesystem quota: WAL readers, backups and other processes can consume additional
disk space. Backups still need an operator retention policy.

A quota or disk failure rolls back the entire batch. HTTP 429 with `Retry-After`
indicates rate, queue or summary-budget pressure; HTTP 507 indicates storage
pressure. Exact content replays skip activity/image replacement, storage scans,
and summary admission charges, but still obey request limits. Collected history
is never automatically evicted. If a legacy database exceeds the storage
ceilings, bootstrap returns 507 before loading activity into memory; it does not
silently truncate history. Stop collection, back up the database, and archive or
move history before retrying. There is currently no automatic archive command or
UI for quota overrides. Limits are centralized in `shared/limits.ts` and
`server/resources.ts`. Changing them requires a reviewed build.
