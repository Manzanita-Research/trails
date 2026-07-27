# trails

Where your days actually went.

A memory system for parallel, agent-heavy, ADHD-shaped work. Not a time tracker — you don't work in blocks, you work in threads. Trails reconstructs your days from the session logs your coding agents already leave behind, so the end of a week is a story you can read instead of a fog you squint at.

## What it believes

- **Days are human-shaped.** The working day starts around 6 am, not midnight. Work at 1 am belongs to the evening it grew out of.
- **Your attention is the real unit.** Agents run for hours; you were there for minutes of it. Trails separates minutes you were prompting and steering from minutes agents ran without you. Billing derives from attention, not wall clock.
- **Threads, not tasks.** Work is in motion, waiting on you, or resting. Resting is a real state, not a failure state. No deadlines, no priority scores.
- **Divergence is safe.** New ideas get caught without abandoning the current thread.

## What exists now

A working prototype on real data:

- `scripts/scan.ts` — walks `~/.claude/projects` and `~/.codex/sessions`, emits metadata-only JSON (per-minute activity, user-event minutes, cwd, branch, first prompt snippet — never transcript bodies). ~500 sessions in ~25s.
- `index.html` / `app.js` / `styles.css` — three views over the scan:
  - **Days** — one card per human-shaped day: parallel project lanes, solid marks where you were present, pale wash where agents ran alone.
  - **Week** — attention-hours per engagement rolled into day-credits (¼ ≥ 1h, ½ ≥ 2.5h, full ≥ 5.5h), the way billing actually works.
  - **Threads** — in motion / waiting on you / resting / dormant, plus a divergence pocket for catching ideas mid-thread.
- Triage lives in the "Sort projects" panel: projects auto-file by repo org, reassign to engagements as needed. Assignments persist in localStorage.

- `scripts/summarize.ts` — an Effect pipeline that turns each session into a one-line contribution summary (Kimi K3 on Workers AI, through Cloudflare AI Gateway), then joins sessions into per-project day rollups. Incremental — reruns only pay for new sessions. The UI picks up `data/summaries.json` automatically and falls back to first-prompt snippets without it.

Run it:

```bash
bun scripts/scan.ts && bun scripts/serve.ts
```

Then open http://localhost:7412.

To enable summaries, create an AI Gateway in the Cloudflare dash (AI → AI Gateway), make an API token with Workers AI + AI Gateway permissions, and put these in `.env`:

```
TRAILS_CF_ACCOUNT_ID=...
TRAILS_CF_GATEWAY=...
TRAILS_CF_TOKEN=...
```

Then `bun scripts/summarize.ts` (try `--limit 20` first, `--dry` prints a digest without calling the API).

## Where it's going

1. **Session hooks** — on `SessionEnd`, append the session's metadata to trails' store and summarize the session's core contribution with a small `claude -p` call (what changed, what's open, what question was being chased). No more full-log rescans.
2. **Real store** — move from a scan blob to an append-only local store (SQLite or JSONL per day), backfill once from local logs + the records R2 archive for anything already offloaded.
3. **Akasha bridge** — daily rollups written to `~/.manzanita/akasha/222-temporal/` in the vault's conventions.
4. **Invoice export** — week view → a plain-text day-credit summary you can paste to a client.
