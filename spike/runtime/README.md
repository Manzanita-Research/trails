# Phase 0 runtime spike: alchemy/Domain on celld vs workerd

_Explore work for MZR-7 (the Trails port plan, §2.5 and the Phase 0 row of
§5). Nothing here is part of the alpha: it has its own `package.json` and
lockfile, nothing outside this folder imports it, and it never touches a live
Trails install or its ports._

**The question.** Can an `alchemy/Domain` model run as a long-lived local
service on an 8 GB Apple Silicon Mac on `celld dev --no-watch` (Route A)? If
not, on workerd with Durable Object storage on local disk (Route C)?

**The answer.** Not on celld as it ships today. The bundle alchemy builds does
not start on celld 0.6.2, and after the first fix its Durable Object calls
hang. With two spike-only workarounds it runs and passes every correctness
check, but it is several times slower and uses more memory than workerd.
workerd runs the same bundle unchanged and passes every check. By §2.5's rule
(Route A only if it passes every check), the recommendation is **Route C now,
celld kept as the target**, with this spike re-run on each celld release.
Choosing Route C is Jem's call (open question 4).

## Results

Three full runs per route on an 8 GB M1 Mac mini, Oct 19 2026: the median, with
the range in brackets. Both full runs use the same bytes (`dist/shimmed`); the
first two rows are smoke tests of the bundle alchemy builds. Per-run tables
and the raw JSON are in `results/`.

| Median of 3 runs (range) | celld dev --no-watch (Route A) | workerd (Route C) |
|---|---|---|
| Serves the bundle alchemy builds, unchanged | **no**: celld did not answer /health within 20 s | yes (3/3) |
| … with only the terminal shim | **no**: Operation timed out after '20s' | n/a |
| Runtime | celld 0.6.2 | workerd 2026-09-18 |
| Works, full run (bundle with the shims) | yes (3/3) | yes (3/3) |
| Cold start to first answer | 426 ms (422 ms–449 ms) | 208 ms (206 ms–223 ms) |
| Register (2 policies, a view, WebSocket push), p50 | 160 ms (154 ms–190 ms) | 33.1 ms (32.8 ms–43.5 ms) |
| Transfer through the saga to a pushed status, p50 | 362 ms (283 ms–443 ms) | 43.8 ms (43.7 ms–47.9 ms) |
| **Command latency, p50** (sequential) | 38 ms (34.4 ms–41 ms) | 13.1 ms (13.1 ms–13.3 ms) |
| **Command latency, p95** (sequential) | 433 ms (430 ms–472 ms) | 17.8 ms (17.3 ms–17.9 ms) |
| Command latency, p99 (sequential) | 812 ms (692 ms–920 ms) | 25.8 ms (21.2 ms–26.4 ms) |
| Under load (8 concurrent), p50 | 62.5 ms (61.7 ms–77 ms) | 53.2 ms (52.2 ms–55 ms) |
| Under load (8 concurrent), p95 | 3151 ms (2701 ms–3380 ms) | 70.6 ms (66.5 ms–71.7 ms) |
| Under load, commands per second | 12.7/s (12.6/s–13.3/s) | 148.3/s (142.5/s–148.9/s) |
| `watch` push over the WebSocket after a command, p50 | 98.5 ms (94.9 ms–103 ms) | 6.9 ms (6.8 ms–8 ms) |
| **Resident memory, idle** | 242 MiB (238 MiB–245 MiB) | 135 MiB (102 MiB–135 MiB) |
| **Resident memory, under load** (peak) | 361 MiB (357 MiB–383 MiB) | 229 MiB (211 MiB–229 MiB) |
| **Clean restart**: state survives, export byte-identical | yes (3/3) | yes (3/3) |
| Clean restart: SIGTERM to exit | 1564 ms (1484 ms–1676 ms) | 22.4 ms (21.5 ms–22.8 ms) |
| Clean restart: back up and answering | 1295 ms (1225 ms–1546 ms) | 108 ms (107 ms–128 ms) |
| **`kill -9` mid-command**: acknowledged commands lost | 0/150, 0/151, 0/150 | 0/153, 0/153, 0/153 |
| `kill -9`: log consistent, and in-flight retries land exactly once | yes (3/3) | yes (3/3) |
| `kill -9`: views catch up with no new command (within 90 s) | **no** | yes (3/3) |
| `kill -9`: accounts whose views waited for their next command | 9, 7, 10 of 10 | 0, 0, 0 of 10 |
| `kill -9`: back up and answering | 902 ms (773 ms–14733 ms) | 97.5 ms (97.4 ms–97.6 ms) |
| **Export** every stream from sequence 0: consistent | yes (3/3) | yes (3/3) |
| Export: time for all streams (34 streams, ~906 events) | 65.4 ms (50.2 ms–111 ms) | 32.3 ms (27 ms–44.6 ms) |
| State on disk while running | 274 MiB (271 MiB–321 MiB) | 237 MiB (237 MiB–237 MiB) |
| State on disk after a clean stop | 121 MiB (118 MiB–126 MiB) | 237 MiB (237 MiB–237 MiB) |

Notes on the table:

- **Memory** is the resident set of the runtime's whole process tree: for
  celld, the `celld dev` supervisor and its node; for workerd, one process.
  Other services shared the machine throughout.
- **celld's tail latency** comes in bursts: most commands take 20–40 ms, and
  some wait 0.4–3 s. A likely cause, not confirmed: in dev mode celld logs
  that "writes wait for the bucket", here a local SQLite object store.
- **`kill -9`, back up and answering** on celld was under a second in two runs
  and 14.7 s in one.
- **Views after `kill -9` on workerd:** none waited in the full runs (10
  accounts, 8 in flight). With 4 accounts and 2 commands in flight per account
  (`results/kill9-small/`), 3 of 4 runs left 2–4 views waiting for their next
  command. This is the alchemy issue below, not a runtime one.

## What it took to run on celld

Two workarounds, plus one thing to know for running it as a service. Each
workaround is a switch in `build.ts` (`--shims terminal,rpc`), so a new
celld or alchemy release can be re-tested without it.

1. **The Worker does not start: `process.stdin.once` (shim `terminal`).**
   alchemy's Worker bridge provides Effect's `NodeServices` to every Worker
   (`Cloudflare/Workers/WorkerBridge.ts`), and building its terminal calls
   `process.stdin.once`. On celld the global `process.stdin` is a plain object,
   and `node:process`'s throws `node:process.stdin.once is not implemented in
   celld`. The shim swaps `@effect/platform-node-shared/NodeTerminal` for a
   terminal that refuses use (`server/shims/NodeTerminal.ts`). A Worker has no
   terminal, so either side could fix this: alchemy by not building one in
   Workers, or celld by stubbing the method.
2. **Durable Object calls never return (shim `rpc`).** alchemy's
   `DurableObjectBridge` returns a `Proxy` from its constructor so that any
   method name reaches the Effect instance. On celld, an RPC call into such an
   object hangs; a plain class with the same method answers. workerd handles
   both. `probes/proxy-rpc` is a 60-line repro (`probes/proxy-rpc/run.sh`
   prints both runtimes side by side). The shim exports, for each Durable
   Object, a plain class that declares every method the Domain platform calls
   (`send`, `state`, `receive`, `append`, the saga's `start`/`poll`, …) and
   forwards it to the bridge.
3. **`celld dev` runs its node as a child process in its own session.**
   Signalling the `celld dev` process only (as `kill -9`, or a supervisor that
   kills one pid) leaves the node running, orphaned, holding the port and the
   state. SIGTERM to the parent is forwarded and shuts both down cleanly. Under
   launchd this needs care.

## Found on both runtimes

- **After `kill -9`, views can stay behind until the next command.** No
  acknowledged command was ever lost, and the event log was always consistent.
  But alchemy's outbox (`queue` in `Domain/Cloudflare.ts`) holds a 60-second
  storage lease while it drains. If the process dies mid-drain, the lease
  survives. The 10-second backstop alarm then finds the lease held and returns
  without rescheduling, and resending a duplicate command does not kick the
  queue. So the staged deliveries wait for the next new command on that
  aggregate. The driver measures it: after `kill -9` it waits 90 s with no new
  commands, then sends one command to each account still behind. This also
  applies on Cloudflare when an instance is reset mid-drain. It is an alchemy
  issue, not a runtime one. In these runs it hit celld every time (7–10 of 10
  accounts) and workerd only when several commands per account were in flight.
- **Disk use is mostly log, not data.** See the last two rows of the table.
  workerd leaves each object's SQLite WAL un-checkpointed, even after a clean
  stop: about 227 MiB of WAL against 6.5 MiB of database in one run. celld
  dev's local object store (`objects.sqlite3`) held about 93 MiB for the same
  work, and a clean stop brings its state to about 120 MiB. Plan §5.1's storage-growth row should be
  measured over days in Phase 2.
- **Export needs the stream names.** The Domain cannot list its instances yet
  (plan §0, gap 1), so `POST /admin/export` reads the streams the caller names.
  The driver names every stream it created: customers, username claims,
  accounts and transfers.

## Method

- **The model:** alchemy's bank example (Apache-2.0, `bank/`, copied from the
  lab with its `LICENSE` and `NOTICE`): 4 aggregates, 7 views, 6 policies,
  2 projections, a stream and a saga, which is 21 Durable Object classes.
  `server/BankWorker.ts` hosts it on `DomainCloudflare.DurableObjects`, as
  alchemy's own example does, with stand-in fraud and payment adapters and the
  ledger in memory (no D1, no Stripe, nothing leaves the machine).
  `Session.ts` and `MfaChallenge.ts` are alchemy's, unchanged but for imports.
- **The bundle:** `build.ts` runs alchemy's own rolldown bundler and virtual
  entry (what `alchemy deploy` uploads) without deploying anything, then writes
  a `wrangler.json` for celld (every class as `new_sqlite_classes`,
  `no_bundle`) and a `config.capnp` for workerd (`durableObjectStorage =
  localDisk`). Pins: `alchemy` preview `9e3c058`, `effect` 4.0.5, workerd
  `1.20260918.1` from npm, celld from its GitHub release
  (`celld.lock.json`, checksum-verified, kept in `.bin/`).
- **The driver** (`driver/spike.ts`) starts one runtime on loopback (celld on
  8792, workerd on 8793), with state in `state/<route>`, and uses the bank's
  own typed `CustomerApi` client: commands over HTTP, `watch` over WebSockets
  (`Domain.protocolWebSocket`), one client per synthetic customer. In order:
  1. Register 10 customers. Each registration runs two policies and a view,
     and the driver waits for the dashboard to show the new account over the
     WebSocket. Then 4 transfers through the saga (a Workflow object, the
     fraud check, alarms), each watched until it settles.
  2. Idle memory: the median of 5 samples after 10 s of quiet. Memory is the
     summed RSS of the runtime's whole process tree (`ps`).
  3. 400 sequential `DepositMoney` commands, round-robin over the 10 accounts.
  4. 400 more with 8 in flight, sampling memory every 100 ms.
  5. 40 commands timed from send to the WebSocket push of the new balance.
  6. Export every stream from sequence 0, and check it: each stream's
     sequence runs 1..version, every `balanceAfter` matches the running
     balance, no command is recorded twice, and every acknowledged command's
     event sits at the version its receipt named.
  7. Clean restart: SIGTERM, start on the same state, export again (must be
     byte-identical), one more command.
  8. `kill -9` of the whole process tree after 150 acknowledgements, with 8
     commands in flight. Restart, export, check. Resend every unacknowledged
     command under its own id, and check each one is recorded exactly once.
     Then wait for every `AccountSummary` view to match its account's log (see
     above).
- **Smoke tests** run the bundle exactly as alchemy builds it (`dist/as-built`)
  and with only the terminal shim (`dist/terminal-only`): start, register one
  customer, one deposit.
- **Repeats:** three full runs, one runtime at a time. The machine was shared
  with other services (including another workerd), so absolute numbers are
  noisy; the ratios held in every run.

## Re-run it

```sh
cd spike/runtime
./run.sh                                   # the pinned celld (celld.lock.json)
CELLD_VERSION=v0.6.3 CELLD_SHA256=<sha256 of celld-aarch64-apple-darwin.gz> ./run.sh
SHIMS=terminal ./run.sh                    # check whether a release fixed the rpc hang
node driver/report.ts results/run-1 results/run-2 results/run-3
```

Apple Silicon macOS only (celld ships no Intel Mac build), Node ≥ 22.18 and
pnpm. Under Claude Code's sandbox, run it with the sandbox off: the sandbox
blocks `ps` and `pgrep`, which the memory samples and the process-tree kill
need. Results land in `results/` (committed); state, builds and the binary in
`state/`, `dist/` and `.bin/` (ignored).

## Upstream asks (for Jem; nobody has been contacted)

1. **alchemy:** don't build a terminal (`NodeServices`) in Workers, or make it
   lazy. Today it breaks any runtime without a full `process.stdin`.
2. **celld** (or alchemy): RPC into a Durable Object whose constructor returns
   a `Proxy`. Either celld supports it, as workerd does, or alchemy's bridge
   declares its methods. Repro: `probes/proxy-rpc`.
3. **alchemy:** the outbox lease after a crash (above). Stage a fresh backstop
   when the lease is held, or let a duplicate command kick the queue.
4. **celld:** a documented way to run `celld dev` under a supervisor (a single
   process, or a flag), since the node runs in its own session.

## Layout

| Path | What |
| --- | --- |
| `bank/` | alchemy's bank example (Apache-2.0, with `LICENSE` and `NOTICE`) |
| `server/BankWorker.ts` | the Worker: the bank on `DomainCloudflare.DurableObjects`, plus `/admin/export` |
| `server/shims/NodeTerminal.ts` | the `terminal` shim |
| `build.ts` | the bundle, `wrangler.json` and `config.capnp`; `--shims` |
| `driver/spike.ts` | one route's run; `--smoke` for the quick check |
| `driver/report.ts` | the results table, median and range over runs |
| `probes/proxy-rpc/` | the minimal celld RPC repro |
| `run.sh` | everything above, end to end |
| `results/` | the runs behind the table |
