/**
 * The Phase 0 runtime spike: start one runtime on loopback, drive the bank's
 * CustomerApi over HTTP and its live reads over WebSockets, and measure what
 * plan §2.5 asks: does it work, command latency, resident memory idle and
 * under load, a clean restart, `kill -9` mid-command, and export from
 * sequence 0. One runtime at a time; every process it starts, it stops.
 *
 *   node driver/spike.ts --route celld|workerd [--bundle dist/shimmed] [--out results/<route>.json]
 *   node driver/spike.ts --route celld --bundle dist/as-built --smoke   (start, one customer, one deposit)
 *
 * Synthetic data only. State lives in ./state/<route>, inside the worktree.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import * as Domain from "alchemy/Domain";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import { AccountId, mainAccountId } from "../bank/src/Account/Account.id.ts";
import { CustomerId } from "../bank/src/Customer/Customer.id.ts";
import { Username } from "../bank/src/Customer/Username.ts";
import { CustomerApi } from "../bank/src/CustomerApi.api.ts";
import { SESSION_COOKIE, sessionClient } from "../bank/src/Session.middleware.ts";
import { TransferId } from "../bank/src/Transfer/Transfer.id.ts";

const root = path.resolve(import.meta.dirname, "..");
const { values: args } = parseArgs({
  options: {
    route: { type: "string" },
    bundle: { type: "string", default: "dist/shimmed" },
    out: { type: "string" },
    commands: { type: "string", default: "400" },
    customers: { type: "string", default: "10" },
    concurrency: { type: "string", default: "8" },
    smoke: { type: "boolean", default: false },
  },
});
const route = args.route as "celld" | "workerd";
if (route !== "celld" && route !== "workerd") throw new Error("--route celld|workerd");
const COMMANDS = Number(args.commands);
const CUSTOMERS = Number(args.customers);
const CONCURRENCY = Number(args.concurrency);
// Never 7412 or 7422: those belong to the live alpha and its planned successor.
const PORT = route === "celld" ? 8792 : 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = "agent:spike";
const RUN = Date.now().toString(36);

const bundleDir = path.resolve(root, args.bundle!);
const stateDir = path.join(root, "state", route);
const logPath = path.join(root, "state", `${route}.log`);

const log = (...parts: ReadonlyArray<unknown>) =>
  console.log(`[${route} ${new Date().toISOString().slice(11, 23)}]`, ...parts);

// ------------------------------------------------------------------ runtime

let child: ChildProcess | undefined;

const command = (): [string, Array<string>] => {
  if (route === "celld") {
    return [
      path.join(root, ".bin/celld"),
      ["dev", path.join(stateDir, "wrangler.json"), "--port", String(PORT), "--no-watch", "--logs"],
    ];
  }
  // The platform binary itself, not npm's `workerd` wrapper, so the pid we
  // measure and kill is the runtime.
  const binary = execFileSync(
    process.execPath,
    ["-e", "console.log(require.resolve('@cloudflare/workerd-darwin-arm64/bin/workerd'))"],
    { cwd: path.join(root, "node_modules/workerd"), encoding: "utf8" },
  ).trim();
  return [
    binary,
    [
      "serve",
      path.join(bundleDir, "config.capnp"),
      "--socket-addr",
      `http=127.0.0.1:${PORT}`,
      "--directory-path",
      `do-storage=${path.join(stateDir, "do")}`,
      "--experimental",
    ],
  ];
};

const fresh = () => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stateDir, "do"), { recursive: true });
  if (route === "celld") {
    // celld dev keeps its state beside the config, in .celld/dev.
    fs.copyFileSync(path.join(bundleDir, "BankWorker.js"), path.join(stateDir, "BankWorker.js"));
    fs.copyFileSync(path.join(bundleDir, "wrangler.json"), path.join(stateDir, "wrangler.json"));
  }
  fs.writeFileSync(logPath, "");
};

const health = async () => {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
};

const start = async (limitMs = 60_000): Promise<number> => {
  if (await health()) throw new Error(`port ${PORT} is already serving`);
  const [bin, argv] = command();
  const out = fs.openSync(logPath, "a");
  fs.writeSync(out, `\n=== start ${new Date().toISOString()}\n`);
  const t0 = performance.now();
  child = spawn(bin, argv, { cwd: stateDir, stdio: ["ignore", out, out] });
  child.on("exit", (code, signal) => fs.appendFileSync(logPath, `=== exit ${code} ${signal}\n`));
  while (performance.now() - t0 < limitMs) {
    if (child.exitCode !== null) throw new Error(`${route} exited at start; see ${logPath}`);
    if (await health()) return performance.now() - t0;
    await sleep(50);
  }
  throw new Error(`${route} did not answer /health within ${limitMs / 1000} s`);
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The runtime and every process under it (celld dev's node runs in its own session). */
const tree = (pid: number): Array<number> => {
  const pids = [pid];
  for (let i = 0; i < pids.length; i++) {
    try {
      const kids = execFileSync("pgrep", ["-P", String(pids[i])], { encoding: "utf8" });
      pids.push(...kids.split("\n").filter(Boolean).map(Number));
    } catch {
      // no children
    }
  }
  return pids;
};

/**
 * Stop the runtime. SIGTERM goes to the main process only, as launchd would
 * send it; SIGKILL goes to every process in the tree at once, like a power
 * cut. Either way, wait until every process is gone.
 */
const stop = async (
  signal: NodeJS.Signals,
  graceMs = 30_000,
): Promise<{ ms: number; timedOut: boolean }> => {
  const running = child;
  if (running?.pid === undefined) return { ms: 0, timedOut: false };
  const pids = tree(running.pid);
  const t0 = performance.now();
  for (const pid of signal === "SIGKILL" ? pids : [running.pid]) {
    if (alive(pid)) process.kill(pid, signal);
  }
  let timedOut = false;
  while (pids.some(alive)) {
    if (!timedOut && performance.now() - t0 > graceMs) {
      timedOut = true;
      for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    }
    await sleep(20);
  }
  child = undefined;
  return { ms: performance.now() - t0, timedOut };
};

/** Resident memory of the runtime and its descendants, in MiB. */
const rss = (): number => {
  if (child?.pid === undefined) return 0;
  const out = execFileSync("ps", ["-o", "rss=", "-p", tree(child.pid).join(",")], {
    encoding: "utf8",
  });
  return (
    out
      .split("\n")
      .filter(Boolean)
      .reduce((kib, line) => kib + Number(line.trim()), 0) / 1024
  );
};

const sampleRss = (everyMs: number) => {
  const samples: Array<number> = [];
  const timer = setInterval(() => {
    try {
      samples.push(rss());
    } catch {
      // the process went away between pgrep and ps
    }
  }, everyMs);
  return { samples, stop: () => clearInterval(timer) };
};

const diskKiB = () =>
  Number(execFileSync("du", ["-sk", stateDir], { encoding: "utf8" }).split("\t")[0]);

// ------------------------------------------------------------------ clients

/**
 * Node's WebSocket, carrying a customer's session cookie on the upgrade: a
 * live read authenticates with what its upgrade request carries, never a
 * header a client sets on calls.
 */
const cookieSockets = (customerId: string) =>
  Layer.succeed(Socket.WebSocketConstructor, (url, options) => {
    const protocols = typeof options === "string" || Array.isArray(options) ? options : undefined;
    return new WebSocket(url, {
      protocols,
      headers: { cookie: `${SESSION_COOKIE}=customer:${customerId}` },
    } as never) as never;
  });

/** One customer's client: calls carry `Authorization`, live reads the session cookie. */
const clientRuntime = (customerId: string) =>
  ManagedRuntime.make(
    CustomerApi.layerClient.pipe(
      Layer.provide(Domain.protocolWebSocket(`${BASE}/api`)),
      Layer.provide(sessionClient(`customer:${customerId}`)),
      Layer.provide(Layer.mergeAll(FetchHttpClient.layer, cookieSockets(customerId))),
    ),
  );
type Rt = ReturnType<typeof clientRuntime>;

type Client = Effect.Success<typeof CustomerApi.client>;

const call = <A, E>(rt: Rt, f: (client: Client) => Effect.Effect<A, E>) =>
  rt.runPromise(
    Effect.flatMap(CustomerApi.Client, f).pipe(Effect.timeout("20 seconds")) as Effect.Effect<
      A,
      unknown
    >,
  );

interface Ack {
  readonly commandId: string;
  readonly stream: string;
  readonly version: number;
  readonly amount: number;
}

const deposit = async (rt: Rt, account: string, amount: number, commandId: string) => {
  const t0 = performance.now();
  const receipt = (await call(rt, (c) =>
    c.DepositMoney({ target: AccountId.make(account), amount, commandId }),
  )) as { readonly stream: string; readonly version: number };
  return {
    ms: performance.now() - t0,
    ack: { commandId, stream: receipt.stream, version: receipt.version, amount } satisfies Ack,
  };
};

// ------------------------------------------------------------------ stats

const percentile = (values: ReadonlyArray<number>, p: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!);
};
const median = (values: ReadonlyArray<number>) => percentile(values, 50);
const round = (n: number) => Math.round(n * 10) / 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const summary = (values: ReadonlyArray<number>) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: values.length ? round(Math.max(...values)) : null,
});

// ------------------------------------------------------------------ export

interface StoredEvent {
  readonly event: {
    readonly _tag: string;
    readonly amount?: number;
    readonly balanceAfter?: number;
  };
  readonly envelope: { readonly stream: string; readonly seq: number; readonly commandId: string };
}

const exportStreams = async (streams: ReadonlyArray<string>) => {
  const t0 = performance.now();
  const response = await fetch(`${BASE}/admin/export`, {
    method: "POST",
    headers: { authorization: `Bearer ${AGENT}`, "content-type": "application/json" },
    body: JSON.stringify({ streams }),
  });
  if (!response.ok) throw new Error(`export answered ${response.status}: ${await response.text()}`);
  const text = await response.text();
  const ms = performance.now() - t0;
  const byStream = new Map<string, { version: number; events: Array<StoredEvent> }>();
  let current: { version: number; events: Array<StoredEvent> } | undefined;
  for (const line of text.split("\n").filter(Boolean)) {
    const row = JSON.parse(line);
    if ("version" in row && "stream" in row && !("envelope" in row)) {
      current = { version: row.version, events: [] };
      byStream.set(row.stream, current);
    } else {
      current!.events.push(row);
    }
  }
  const events = [...byStream.values()].reduce((n, s) => n + s.events.length, 0);
  return { ms, bytes: text.length, events, streams: byStream.size, byStream, text };
};

const CREDITS = new Set([
  "MoneyDeposited",
  "TransferCredited",
  "TransferRefunded",
  "SettlementReceived",
]);
const DEBITS = new Set(["MoneyWithdrawn", "TransferDebited"]);

/**
 * What must hold after any stop, clean or not: each stream's sequence runs
 * 1..version with no gap; every running balance agrees with every recorded
 * `balanceAfter`; no command id appears twice; and every acknowledged
 * command's event sits at the version its receipt named.
 */
const verify = (exported: Awaited<ReturnType<typeof exportStreams>>, acks: ReadonlyArray<Ack>) => {
  const problems: Array<string> = [];
  const balances = new Map<string, number>();
  for (const [stream, { version, events }] of exported.byStream) {
    if (events.length !== version)
      problems.push(`${stream}: ${events.length} events, version ${version}`);
    events.forEach((e, i) => {
      if (e.envelope.seq !== i + 1)
        problems.push(`${stream}: seq ${e.envelope.seq} at position ${i + 1}`);
    });
    // A command may record several events, at consecutive sequence numbers;
    // the same command id anywhere else is a duplicate.
    const lastSeqOf = new Map<string, number>();
    for (const e of events) {
      const last = lastSeqOf.get(e.envelope.commandId);
      if (last !== undefined && last !== e.envelope.seq - 1) {
        problems.push(`${stream}: command ${e.envelope.commandId} recorded twice`);
      }
      lastSeqOf.set(e.envelope.commandId, e.envelope.seq);
    }
    if (stream.startsWith("Account/")) {
      let balance = 0;
      for (const { event, envelope } of events) {
        if (CREDITS.has(event._tag)) balance += event.amount!;
        if (DEBITS.has(event._tag)) balance -= event.amount!;
        if (event.balanceAfter !== undefined && event.balanceAfter !== balance) {
          problems.push(
            `${stream}@${envelope.seq}: balanceAfter ${event.balanceAfter}, running ${balance}`,
          );
        }
      }
      balances.set(stream, balance);
    }
  }
  let lost = 0;
  for (const ack of acks) {
    const stream = exported.byStream.get(ack.stream);
    const event = stream?.events[ack.version - 1];
    if (event?.envelope.commandId !== ack.commandId) {
      lost++;
      problems.push(`acknowledged ${ack.commandId} missing at ${ack.stream}@${ack.version}`);
    }
  }
  return { ok: problems.length === 0, lost, problems: problems.slice(0, 20), balances };
};

// ------------------------------------------------------------------ the run

const result: Record<string, unknown> = {
  route,
  run: RUN,
  port: PORT,
  bundle: path.relative(root, bundleDir),
};
const runtimes: Array<Rt> = [];

const main = async () => {
  const version = execFileSync(
    route === "celld" ? path.join(root, ".bin/celld") : command()[0],
    ["--version"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  result.version =
    version
      .split("\n")
      .filter((line) => line.startsWith(route))
      .pop() ?? version.trim();
  fresh();

  if (args.smoke) {
    // Does the bundle serve at all? Start, register one customer through the
    // policies (watched over a WebSocket), deposit once.
    result.coldStartMs = round(await start(20_000));
    const c = `c-${RUN}-smoke`;
    const rt = clientRuntime(c);
    runtimes.push(rt);
    await call(rt, (client) =>
      Effect.gen(function* () {
        yield* client.RegisterCustomer({
          target: CustomerId.make(c),
          name: "Smoke",
          username: Username.make(`u${RUN}smoke`),
        });
        yield* client.CustomerDashboard.watch(CustomerId.make(c)).pipe(
          Stream.filter((d) => d !== null && mainAccountId(CustomerId.make(c)) in d.balances),
          Stream.runHead,
        );
      }),
    );
    result.depositMs = round(
      (await deposit(rt, mainAccountId(CustomerId.make(c)), 100, `smoke-${RUN}`)).ms,
    );
    result.works = true;
    return;
  }

  // 1. Start on empty state.
  result.coldStartMs = round(await start());
  log("ready in", result.coldStartMs, "ms");

  // 2. Setup through the policies: register customers and watch each
  //    dashboard over a WebSocket until MainAccountProvisioning opens the
  //    main account (RegisterCustomer → UsernameReservation →
  //    ConfirmRegistration → MainAccountProvisioning → OpenAccount → views).
  const customers = Array.from({ length: CUSTOMERS }, (_, i) => `c-${RUN}-${i}`);
  const accounts = customers.map((c) => mainAccountId(CustomerId.make(c)) as string);
  for (const c of customers) runtimes.push(clientRuntime(c));
  const registerMs: Array<number> = [];
  for (const [i, c] of customers.entries()) {
    const t0 = performance.now();
    await call(runtimes[i]!, (client) =>
      Effect.gen(function* () {
        const id = CustomerId.make(c);
        yield* client.RegisterCustomer({
          target: id,
          name: `Synthetic ${i}`,
          username: Username.make(`u${RUN}${i}`),
        });
        yield* client.CustomerDashboard.watch(id).pipe(
          Stream.filter((d) => d !== null && accounts[i]! in d.balances),
          Stream.runHead,
        );
      }),
    );
    registerMs.push(performance.now() - t0);
  }
  result.registerViaPoliciesAndWatch = summary(registerMs);
  log("registered", customers.length, "customers; p50", median(registerMs), "ms");

  // Seed each account, then run transfers through the saga (Workflow DO,
  // fraud check, alarms) and watch TransferStatus until each settles.
  const acks: Array<Ack> = [];
  for (const [i, a] of accounts.entries())
    acks.push((await deposit(runtimes[i]!, a, 50_000, `seed-${RUN}-${i}`)).ack);
  const transferMs: Array<number> = [];
  const transfers: Array<string> = [];
  for (let i = 0; i < 4; i++) {
    const transferId = `t-${RUN}-${i}`;
    transfers.push(transferId);
    const t0 = performance.now();
    const status = await call(runtimes[i]!, (client) =>
      Effect.gen(function* () {
        yield* client.RequestTransfer(
          {
            target: TransferId.make(transferId),
            from: AccountId.make(accounts[i]!),
            to: AccountId.make(accounts[(i + 1) % CUSTOMERS]!),
            amount: 1_000,
          },
          { headers: { "x-mfa-code": "000000" } },
        );
        return yield* client.TransferStatus.watch(TransferId.make(transferId)).pipe(
          Stream.filter((s) => s !== null && (s.completedAt !== null || s.failedReason !== null)),
          Stream.runHead,
        );
      }),
    );
    transferMs.push(performance.now() - t0);
    const settled = (status as { value?: { completedAt: unknown; failedReason: string | null } })
      .value;
    log(
      "transfer",
      transferId,
      settled?.completedAt ? "completed" : `failed: ${settled?.failedReason}`,
    );
  }
  result.transferViaSagaAndWatch = summary(transferMs);

  // 3. Idle memory, after the setup has settled.
  await sleep(10_000);
  const idle: Array<number> = [];
  for (let i = 0; i < 5; i++) {
    idle.push(rss());
    await sleep(1_000);
  }
  result.rssIdleMiB = median(idle);
  log("idle RSS", result.rssIdleMiB, "MiB");

  // 4. Sequential command latency: DepositMoney round-robin over the accounts.
  const sequential: Array<number> = [];
  for (let i = 0; i < COMMANDS; i++) {
    const { ms, ack } = await deposit(
      runtimes[i % CUSTOMERS]!,
      accounts[i % CUSTOMERS]!,
      100 + (i % 7),
      `seq-${RUN}-${i}`,
    );
    sequential.push(ms);
    acks.push(ack);
  }
  result.commandLatencyMs = summary(sequential);
  log("sequential", JSON.stringify(result.commandLatencyMs));

  // 5. Under load: CONCURRENCY workers, with memory sampled throughout.
  const sampler = sampleRss(100);
  const loaded: Array<number> = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < COMMANDS) {
        const i = next++;
        const { ms, ack } = await deposit(
          runtimes[i % CUSTOMERS]!,
          accounts[i % CUSTOMERS]!,
          200 + (i % 5),
          `load-${RUN}-${i}`,
        );
        loaded.push(ms);
        acks.push(ack);
      }
    }),
  );
  const loadSeconds = (performance.now() - t0) / 1000;
  sampler.stop();
  result.underLoad = {
    concurrency: CONCURRENCY,
    latencyMs: summary(loaded),
    commandsPerSecond: round(COMMANDS / loadSeconds),
    rssPeakMiB: round(Math.max(...sampler.samples)),
    rssMedianMiB: median(sampler.samples),
  };
  log("load", JSON.stringify(result.underLoad));

  // 6. Push latency: a WebSocket watch on one dashboard, timing each
  //    deposit's acknowledgement to the pushed balance.
  const pushMs: Array<number> = [];
  {
    const rt = runtimes[0]!;
    const seen: Array<{ balance: number; at: number }> = [];
    const watching = rt.runFork(
      Effect.flatMap(CustomerApi.Client, (c: Client) =>
        c.CustomerDashboard.watch(CustomerId.make(customers[0]!)).pipe(
          Stream.runForEach((d) =>
            Effect.sync(() => {
              const balance = d?.balances[accounts[0] as AccountId];
              if (balance !== undefined) seen.push({ balance, at: performance.now() });
            }),
          ),
        ),
      ),
    );
    await sleep(1_000);
    for (let i = 0; i < 40; i++) {
      const sent = performance.now();
      const receipt = (await call(rt, (c) =>
        c.DepositMoney({
          target: AccountId.make(accounts[0]!),
          amount: 1,
          commandId: `push-${RUN}-${i}`,
        }),
      )) as { stream: string; version: number; reply: { balance: number } };
      acks.push({
        commandId: `push-${RUN}-${i}`,
        stream: receipt.stream,
        version: receipt.version,
        amount: 1,
      });
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const hit = seen.find((s) => s.balance === receipt.reply.balance && s.at >= sent);
        if (hit) {
          pushMs.push(hit.at - sent);
          break;
        }
        await sleep(2);
      }
    }
    await rt.runPromise(Fiber.interrupt(watching)).catch(() => undefined);
  }
  result.watchPushMs = {
    ...summary(pushMs),
    note: "deposit sent → dashboard balance pushed over the WebSocket",
  };
  log("push", JSON.stringify(result.watchPushMs));

  // 7. Export every stream from sequence 0 and check it.
  const streams = [
    ...customers.map((c) => `Customer/${c}`),
    ...customers.map((_, i) => `UsernameClaim/u${RUN}${i}`),
    ...accounts.map((a) => `Account/${a}`),
    ...transfers.map((t) => `Transfer/${t}`),
  ];
  const before = await exportStreams(streams);
  const beforeCheck = verify(before, acks);
  result.export = {
    streams: before.streams,
    events: before.events,
    bytes: before.bytes,
    ms: round(before.ms),
    consistent: beforeCheck.ok,
    problems: beforeCheck.problems,
  };
  log("export", before.events, "events in", round(before.ms), "ms; consistent:", beforeCheck.ok);

  // 8. Clean restart: SIGTERM, start on the same state, export again.
  const stopped = await stop("SIGTERM");
  const restartMs = await start();
  const afterRestart = await exportStreams(streams);
  const restartCheck = verify(afterRestart, acks);
  const probe = await deposit(runtimes[1]!, accounts[1]!, 1, `after-restart-${RUN}`);
  acks.push(probe.ack);
  result.cleanRestart = {
    stopMs: round(stopped.ms),
    stopNeededSigkill: stopped.timedOut,
    readyMs: round(restartMs),
    identicalExport: afterRestart.text === before.text,
    consistent: restartCheck.ok,
    lostAcknowledged: restartCheck.lost,
    firstCommandAfterMs: round(probe.ms),
    problems: restartCheck.problems,
  };
  log("restart", JSON.stringify(result.cleanRestart));

  // 9. kill -9 with CONCURRENCY commands in flight.
  const sent = new Map<string, { account: string; amount: number }>();
  const acked = new Set<string>();
  const killAcks: Array<Ack> = [];
  let killed = false;
  let k = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!killed) {
      const i = k++;
      const commandId = `k9-${RUN}-${i}`;
      const account = accounts[i % CUSTOMERS]!;
      sent.set(commandId, { account, amount: 300 + (i % 3) });
      try {
        const { ack } = await deposit(runtimes[i % CUSTOMERS]!, account, 300 + (i % 3), commandId);
        acked.add(commandId);
        killAcks.push(ack);
        acks.push(ack);
      } catch {
        return; // the runtime is gone
      }
    }
  });
  while (acked.size < 150) await sleep(1);
  killed = true;
  await stop("SIGKILL");
  await Promise.all(workers);
  const inFlight = [...sent.keys()].filter((id) => !acked.has(id));
  const recoverMs = await start();
  const afterKill = await exportStreams(streams);
  const killCheck = verify(afterKill, acks);
  // Retry every unacknowledged command under its own id: each must end up
  // recorded exactly once, whether or not it committed before the kill.
  let retried = 0;
  for (const commandId of inFlight) {
    const { account, amount } = sent.get(commandId)!;
    const i = accounts.indexOf(account);
    const { ack } = await deposit(runtimes[i]!, account, amount, commandId);
    acks.push(ack);
    retried++;
  }
  const afterRetry = await exportStreams(streams);
  const retryCheck = verify(afterRetry, acks);
  const occurrences = (id: string) =>
    [...afterRetry.byStream.values()]
      .flatMap((s) => s.events)
      .filter((e) => e.envelope.commandId === id).length;
  const notOnce = [...sent.keys()].filter((id) => occurrences(id) !== 1);
  // The views are fed by each aggregate's outbox, which must survive the kill:
  // every AccountSummary should converge on the aggregate's balance without
  // any new command. If it has not after 90 s, send each lagging account one
  // fresh command (a new commit kicks its outbox) and wait again.
  const lagging = async () => {
    const out: Array<string> = [];
    for (const [i, a] of accounts.entries()) {
      const view = (await call(runtimes[i]!, (c) => c.AccountSummary.get(AccountId.make(a)))) as {
        balance: number;
      } | null;
      const expected = balancesOf(await exportStreams([`Account/${a}`]));
      if (view?.balance !== expected) out.push(a);
    }
    return out;
  };
  const balancesOf = (e: Awaited<ReturnType<typeof exportStreams>>) =>
    [...e.byStream.values()][0]!.events.reduce(
      (b, { event }) =>
        CREDITS.has(event._tag)
          ? b + event.amount!
          : DEBITS.has(event._tag)
            ? b - event.amount!
            : b,
      0,
    );
  const waitConverged = async (limitMs: number) => {
    const t = performance.now();
    let behind = await lagging();
    while (behind.length > 0 && performance.now() - t < limitMs) {
      await sleep(500);
      behind = await lagging();
    }
    return { behind, ms: performance.now() - t };
  };
  const sinceRestart = performance.now();
  const unaided = await waitConverged(90_000);
  let afterKick: { behind: Array<string>; ms: number } | null = null;
  if (unaided.behind.length > 0) {
    for (const a of unaided.behind) {
      acks.push((await deposit(runtimes[accounts.indexOf(a)]!, a, 1, `kick-${RUN}-${a}`)).ack);
    }
    afterKick = await waitConverged(30_000);
  }
  const converged = {
    ok: unaided.behind.length === 0,
    msAfterRestart: unaided.behind.length === 0 ? round(performance.now() - sinceRestart) : null,
    stuckWithoutNewCommand: unaided.behind.length,
    convergedAfterOneNewCommand: afterKick ? afterKick.behind.length === 0 : null,
    mismatches: (afterKick?.behind ?? unaided.behind).map((a) => `${a}: view behind the log`),
  };
  result.kill9 = {
    acknowledgedBeforeKill: killAcks.length,
    inFlightAtKill: inFlight.length,
    readyMs: round(recoverMs),
    lostAcknowledged: killCheck.lost,
    consistentAfterKill: killCheck.ok,
    retriedInFlight: retried,
    exactlyOnceAfterRetry: notOnce.length === 0,
    consistentAfterRetry: retryCheck.ok,
    viewsConvergedWithoutNewCommands: converged.ok,
    viewsConvergedMs: converged.msAfterRestart,
    viewsStuckUntilNextCommand: converged.stuckWithoutNewCommand,
    viewsConvergedAfterOneNewCommand: converged.convergedAfterOneNewCommand,
    problems: [
      ...killCheck.problems,
      ...retryCheck.problems,
      ...converged.mismatches,
      ...notOnce.map((id) => `${id} recorded ${occurrences(id)}×`),
    ].slice(0, 20),
  };
  log("kill -9", JSON.stringify(result.kill9));

  // 10. Final export and storage on disk.
  const final = await exportStreams(streams);
  result.finalExport = {
    streams: final.streams,
    events: final.events,
    bytes: final.bytes,
    ms: round(final.ms),
  };
  result.stateOnDiskKiB = diskKiB();
  result.works = Boolean(
    beforeCheck.ok &&
    (result.cleanRestart as { consistent: boolean }).consistent &&
    killCheck.lost === 0 &&
    retryCheck.ok &&
    notOnce.length === 0 &&
    (converged.ok || converged.convergedAfterOneNewCommand === true),
  );
};

const finish = async (error?: unknown) => {
  if (error !== undefined) {
    result.works = false;
    // The message only: stacks carry local paths, and results are committed.
    result.error = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    log("FAILED", result.error);
  }
  await Promise.all(runtimes.map((rt) => rt.dispose().catch(() => undefined)));
  await stop("SIGTERM");
  // After a clean stop, so write-ahead logs that a shutdown checkpoints are counted as it leaves them.
  if (!args.smoke && fs.existsSync(stateDir)) result.stateOnDiskAfterStopKiB = diskKiB();
  const out = path.resolve(root, args.out ?? `results/${route}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // Results are committed to a public repo: no machine paths in them.
  const text = JSON.stringify(result, null, 2)
    .replaceAll(root, ".")
    .replaceAll(process.env.HOME ?? "\0", "~");
  fs.writeFileSync(out, `${text}\n`);
  log("wrote", path.relative(root, out));
};

process.on("SIGINT", () => {
  if (child?.pid !== undefined) for (const pid of tree(child.pid)) process.kill(pid, "SIGKILL");
  process.exit(130);
});

await main().then(
  () => finish(),
  (error) => finish(error),
);
process.exit(result.works ? 0 : 1);
