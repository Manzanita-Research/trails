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

- Raw material: local session logs at `~/.claude/projects` (Claude Code) and `~/.codex/sessions` (Codex), scanned into metadata-only JSON (~500 sessions in ~25s).
- Days are human-shaped: the working day starts around 6 am; 1 am work belongs to the evening it grew out of. Timezone currently pinned to America/Los_Angeles.
- Work states: threads are in motion, waiting on you, or resting — resting is a real state, not a failure state. No deadlines, no priority scores. Divergence (new ideas mid-thread) gets caught without abandoning the current thread.
- Billing model: attention-hours roll into day-credits (¼ ≥ 1h, ½ ≥ 2.5h, full ≥ 5.5h), matching how freelance billing actually works.
- Triage: projects auto-file by repo org and can be reassigned to engagements; assignments persist locally.
- Summarization: sessions become one-line contribution summaries via Kimi K3 on Workers AI through Cloudflare AI Gateway, incremental so reruns only pay for new sessions.

## Capabilities and Constraints

- **Multi-machine is required.** The first user alone works across three Macs, a VPS, and cloud coding agents; a single-machine scan blob cannot be the end state.
- **Privacy boundary:** metadata and short prompt snippets may go to the AI for summarization; full transcript bodies stay out of any centrally hosted service. Syncing your own data across your own machines/infra is fine.
- **Open decision — distribution shape:** a Manzanita-hosted app "sounds scary"; the leaning is something people run themselves on their own Cloudflare infra. Undecided, do not assume either.
- Stack: Bun, Vite, React 19, TypeScript, Effect (summarize pipeline), Cloudflare Worker (keyless AI binding proxy). Deploys via wrangler.
- Terminology in use: threads, engagements, day-credits, divergence pocket, attention vs. wall clock, human-shaped days, in motion / waiting on you / resting / dormant.
- Planned direction (from README, unconfirmed as commitments): SessionEnd hooks instead of full rescans, an append-only local store, an Akasha vault bridge, invoice export from the week view.

## Brand Commitments

- Name: **trails** (lowercase in prose and UI so far). A Manzanita Research project — note the org names projects after California native plants; whether "trails" is the durable public name is unconfirmed.
- Voice: Manzanita brand voice applies (warm, grounded, direct; never corporate; no hype vocabulary). Existing copy sets the register: "Where your days actually went."
- Values that bind product decisions: local-first/offline-first, no surveillance of creative work, instruments not automations.

## Evidence on Hand

- A working prototype on real data: three views (Days, Week, Threads) over ~500 real scanned sessions, plus working AI summarization (`public/data/scan.json`, `data/summaries.json`).
- No testimonials, case studies, benchmarks, pricing, or third-party proof exist. Future marketing/docs work must not fabricate any.

## Product Principles

1. **Read the exhaust, never add ceremony.** Trails must work from what agents already leave behind; any feature that asks the user to log, tag, or track as they go is off-mission.
2. **Attention is the unit.** Presence-minutes, not wall clock, drive every number shown — memory views and billing math alike.
3. **Days are human-shaped and states are judgment-free.** The 6 am day boundary and "resting is not failure" are product positions, not implementation details.
4. **Metadata over transcripts.** Every pipeline stage stays metadata-only; summaries derive from the smallest text that works.
5. **Yours to run.** Whatever the distribution shape becomes, users hold their own data and their own infrastructure keys.
