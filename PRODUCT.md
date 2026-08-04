# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People doing parallel, agent-heavy, ADHD-shaped work — developers and freelancers running multiple coding agents (Claude Code, Codex) across many projects at once, whose days fragment into threads rather than blocks. Jem is the first user and the design-truth source; trails is intended as a public Manzanita release, so generality for other agent-heavy workers is a real requirement, not a maybe-later.

Their situation: at the end of a day or week, they can't reconstruct where their attention went. Session logs hold the answer but are unreadable as-is. Many work freelance and need to bill clients from that reconstruction.

## Product Purpose

Trails reconstructs your days from the session logs your coding agents already leave behind, turning the end of a week into a story you can read instead of a fog you squint at. It is a memory system, not a time tracker.

**Memory leads.** The readable week is the product; billing (attention-derived day-credits, invoice export) is a valuable derivative of good memory, not the defining job.

## Positioning

Time trackers assume you work in blocks and require you to log as you go. Trails assumes you work in threads and requires nothing — it reads the exhaust your agents already produce. Its distinctive mechanism: separating minutes you were actually present (prompting, steering) from minutes agents ran without you, so attention — not wall clock — becomes the unit of both memory and billing.

## Operating Context

- Raw material: local Claude Code, Codex, omp, and pi session logs. A periodic collector parses changed files on each Mac and submits normalized observations to the owner's hub; transcript paths and bodies never cross the source-machine boundary.
- Days are human-shaped: the working day starts around 6 am; 1 am work belongs to the evening it grew out of. Timezone currently pinned to America/Los_Angeles.
- Work states: threads are in motion, waiting on you, or resting — resting is a real state, not a failure state. No deadlines, no priority scores. Divergence (new ideas mid-thread) gets caught without abandoning the current thread.
- Billing model: attention-hours roll into day-credits (¼ ≥ 1h, ½ ≥ 2.5h, full ≥ 5.5h), matching how freelance billing actually works.
- Triage: projects auto-file by repo org and can be reassigned to shared engagements. Assignments, display names, settings, and divergence-pocket items persist canonically in SQLite and synchronize across browsers.
- Summarization: changed sessions settle for five minutes, then durable jobs send bounded digests through an authenticated Cloudflare Workers AI relay. Sessions become one-line contribution summaries; project/day rollups are guarded against stale model responses.
- Feedback: testers can explicitly send a kind, message, optional follow-up, and optional bounded safe context directly to a separate public-write Cloudflare Worker/D1 store. The store has no public read route; records expire after 90 days and are deleted by the next daily cleanup.

## Capabilities and Constraints

- **One machine is complete.** The hub Mac owns the canonical SQLite service and runs its own one-shot collector every 60 seconds; no separate client, server, or Tailscale account is required.
- **Multi-machine is optional.** Tailscale Serve privately exposes the same hub, and each spoke Mac syncs normalized observations idempotently every 60 seconds.
- **Privacy boundary:** normalized metadata and bounded digests may leave a source machine. Full transcript bodies and local transcript paths do not. Browser bootstrap omits source-local session IDs and digests. Feedback leaves the browser only when sent; optional safe context contains only app version, view, revision, selected Days/Project work date, source counts, viewport dimensions, and sync-error state.
- **Distribution shape:** two standalone macOS executables (`arm64`, `x64`) embed Bun, SQLite, and the built client. Target Macs require no runtime or repository checkout. The product stages its own installer and artifacts; shared Manzanita release infrastructure stores immutable versioned objects in R2, publishes a short-lived alpha channel pointer, and serves the stable checksum-pinned installer at `https://releases.manzanita.dev/trails/install.sh`. Users retain ownership of their hub, database, backups, optional tailnet, and optional Cloudflare token.
- Stack: Bun, `bun:sqlite`, Vite, React 19, TypeScript, Effect, optional Tailscale Serve, launchd, a narrowly scoped authenticated Cloudflare Workers AI relay, and a separate public-write/no-public-read feedback Worker with expiring D1 records.
- Terminology in use: threads, engagements, day-credits, divergence pocket, attention vs. wall clock, human-shaped days, in motion / waiting on you / resting / dormant.
- Still unimplemented product directions: Akasha vault bridge and invoice export from the week view.

## Brand Commitments

- Name: **trails** (lowercase in prose and UI so far). A Manzanita Research project — note the org names projects after California native plants; whether "trails" is the durable public name is unconfirmed.
- Voice: Manzanita brand voice applies (warm, grounded, direct; never corporate; no hype vocabulary). Existing copy sets the register: "Where your days actually went."
- Values that bind product decisions: local-first/offline-first, no surveillance of creative work, instruments not automations.

## Evidence on Hand

- A working end-to-end implementation: standalone one-Mac hub/collector service, optional periodic multi-Mac collectors through Tailscale, canonical SQLite state, Days/Week/Threads/project views, durable summaries, launchd installation, and WAL-safe backups.
- No testimonials, case studies, benchmarks, pricing, or third-party proof exist. Future marketing/docs work must not fabricate any.

## Product Principles

1. **Read the exhaust, never add ceremony.** Trails must work from what agents already leave behind; any feature that asks the user to log, tag, or track as they go is off-mission.
2. **Attention is the unit.** Presence-minutes, not wall clock, drive every number shown — memory views and billing math alike.
3. **Days are human-shaped and states are judgment-free.** The 6 am day boundary and "resting is not failure" are product positions, not implementation details.
4. **Metadata over transcripts.** Every pipeline stage derives the smallest bounded text that works; raw transcript bodies stay on their source machines.
5. **Yours to run.** Whatever the distribution shape becomes, users hold their own data and their own infrastructure keys.
