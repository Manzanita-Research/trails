# trails

Where your days actually went.

A memory system for parallel, agent-heavy, ADHD-shaped work. Not a time tracker — you don't work in blocks, you work in threads. Trails reconstructs your days from the session logs your coding agents already leave behind, so the end of a week is a story you can read instead of a fog you squint at.

## What it believes

- **Days are human-shaped.** The working day starts around 6 am, not midnight. Work at 1 am belongs to the evening it grew out of.
- **Your attention is the real unit.** Agents run for hours; you were there for minutes of it. Trails separates minutes you were prompting and steering from minutes agents ran without you. Billing derives from attention, not wall clock.
- **Threads, not tasks.** Work is in motion, waiting on you, or resting. Resting is a real state, not a failure state. No deadlines, no priority scores.
- **Divergence is safe.** New ideas get caught without abandoning the current thread.

## What exists now

A working app on real data — Vite + React frontend, a Cloudflare Worker for inference, Effect pipelines for the data work:

- `scripts/scan.ts` — walks `~/.claude/projects` and `~/.codex/sessions`, emits metadata-only JSON (per-minute activity, user-event minutes, cwd, branch, first prompt snippet — never transcript bodies) to `public/data/scan.json`. ~500 sessions in ~25s.
- `src/` — the React app, three views over the scan:
  - **Days** — one card per human-shaped day: parallel project lanes, solid marks where you were present, pale wash where agents ran alone.
  - **Week** — attention-hours per engagement rolled into day-credits (¼ ≥ 1h, ½ ≥ 2.5h, full ≥ 5.5h), the way billing actually works.
  - **Threads** — in motion / waiting on you / resting / dormant, plus a divergence pocket for catching ideas mid-thread.
- Triage lives in the "Sort projects" panel: projects auto-file by repo org, reassign to engagements as needed. Assignments, renames, and settings persist in localStorage.
- `worker/index.ts` — a Worker with a Workers AI binding (`env.AI`). `POST /api/summarize` takes `{system, user}` and runs Kimi K2.5 (`@cf/moonshotai/kimi-k2.5`). No API keys anywhere: in dev the binding proxies through wrangler's OAuth login (`"remote": true` in `wrangler.jsonc`); deployed, it's native.
- `scripts/summarize.ts` — an Effect pipeline that digests each session transcript (bounded extract, never the full log), asks the worker for a one-line contribution summary, then joins sessions into per-project day rollups. Incremental — reruns only pay for new sessions. The UI picks up `public/data/summaries.json` automatically and falls back to first-prompt snippets without it.

Run it:

```bash
bun run scan   # build public/data/scan.json
bun run dev    # vite + worker on http://localhost:7412
```

Then, with the dev server up, `bun run summarize` (`--limit 20` to sample first, `--dry` prints a digest without calling the model). Point `TRAILS_WORKER_URL` at a deployed worker to summarize against prod.

`bun run deploy` builds and ships the whole thing (static app + worker) with wrangler.

Note on models: Kimi K3 proper (`moonshotai/kimi-k3`) is a third-party partner model on Cloudflare — it needs AI Gateway Unified Billing credits enabled on the account. Until then trails uses `@cf/moonshotai/kimi-k2.5`, hosted natively on Workers AI, which the OAuth login covers with zero setup. Switching later is a one-line change in `worker/index.ts`.

## Where it's going

1. **Session hooks** — on `SessionEnd`, append the session's metadata to trails' store and summarize the session's core contribution with a small `claude -p` call (what changed, what's open, what question was being chased). No more full-log rescans.
2. **Real store** — move from a scan blob to an append-only local store (SQLite or JSONL per day), backfill once from local logs + the records R2 archive for anything already offloaded.
3. **Akasha bridge** — daily rollups written to `~/.manzanita/akasha/222-temporal/` in the vault's conventions.
4. **Invoice export** — week view → a plain-text day-credit summary you can paste to a client.
