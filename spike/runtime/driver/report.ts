/**
 * Render the spike's results as a Markdown table, celld vs workerd. Given
 * several result directories (repeated runs), each number is the median
 * across runs with the range in brackets, and each yes/no counts the runs.
 *
 *   node driver/report.ts results/run-1 [results/run-2 ...]
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Json = Record<string, any>;
const dirs = (process.argv.length > 2 ? process.argv.slice(2) : ["results"]).map((d) =>
  path.resolve(d),
);
const load = (name: string): Array<Json> =>
  dirs
    .map((dir) => path.join(dir, `${name}.json`))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));

const runs = { celld: load("celld"), workerd: load("workerd") };
const smoke = {
  celldAsBuilt: load("celld-as-built"),
  celldTerminal: load("celld-terminal-only"),
  workerdAsBuilt: load("workerd-as-built"),
};

const median = (xs: Array<number>) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const fmt = (n: number, unit: string) =>
  unit === "MiB"
    ? `${Math.round(n)} MiB`
    : unit === "ms"
      ? `${n >= 100 ? Math.round(n) : Math.round(n * 10) / 10} ms`
      : `${Math.round(n * 10) / 10}${unit}`;

/** A number per run: the median, and the range when there are several runs. */
const num =
  (get: (r: Json) => unknown, unit = "ms") =>
  (rs: Array<Json>) => {
    const xs = rs.map(get).filter((x): x is number => typeof x === "number");
    if (xs.length === 0) return "–";
    const mid = fmt(median(xs), unit);
    return xs.length === 1
      ? mid
      : `${mid} (${fmt(Math.min(...xs), unit)}–${fmt(Math.max(...xs), unit)})`;
  };
/** A yes/no per run: "yes", "**no**", or how many runs said yes. */
const yes = (get: (r: Json) => unknown) => (rs: Array<Json>) => {
  const xs = rs.map(get).filter((x) => typeof x === "boolean");
  if (xs.length === 0) return "–";
  const n = xs.filter(Boolean).length;
  return n === xs.length
    ? xs.length === 1
      ? "yes"
      : `yes (${n}/${xs.length})`
    : n === 0
      ? "**no**"
      : `**${n}/${xs.length} runs**`;
};
const smokeCell = (rs: Array<Json>) => {
  if (rs.length === 0) return "–";
  const failed = rs.filter((r) => !r.works);
  return failed.length === 0
    ? yes((r) => r.works)(rs)
    : `**no**: ${String(failed[0]!.error ?? "").slice(0, 80)}`;
};

const rows: Array<[string, (rs: Array<Json>) => string]> = [
  ["Runtime", (rs) => [...new Set(rs.map((r) => r.version))].join(", ") || "–"],
  ["Works, full run (bundle with the shims)", yes((r) => r.works)],
  ["Cold start to first answer", num((r) => r.coldStartMs)],
  [
    "Register (2 policies, a view, WebSocket push), p50",
    num((r) => r.registerViaPoliciesAndWatch?.p50),
  ],
  ["Transfer through the saga to a pushed status, p50", num((r) => r.transferViaSagaAndWatch?.p50)],
  ["**Command latency, p50** (sequential)", num((r) => r.commandLatencyMs?.p50)],
  ["**Command latency, p95** (sequential)", num((r) => r.commandLatencyMs?.p95)],
  ["Command latency, p99 (sequential)", num((r) => r.commandLatencyMs?.p99)],
  ["Under load (8 concurrent), p50", num((r) => r.underLoad?.latencyMs?.p50)],
  ["Under load (8 concurrent), p95", num((r) => r.underLoad?.latencyMs?.p95)],
  ["Under load, commands per second", num((r) => r.underLoad?.commandsPerSecond, "/s")],
  ["`watch` push over the WebSocket after a command, p50", num((r) => r.watchPushMs?.p50)],
  ["**Resident memory, idle**", num((r) => r.rssIdleMiB, "MiB")],
  ["**Resident memory, under load** (peak)", num((r) => r.underLoad?.rssPeakMiB, "MiB")],
  [
    "**Clean restart**: state survives, export byte-identical",
    yes((r) => r.cleanRestart?.consistent && r.cleanRestart?.identicalExport),
  ],
  ["Clean restart: SIGTERM to exit", num((r) => r.cleanRestart?.stopMs)],
  ["Clean restart: back up and answering", num((r) => r.cleanRestart?.readyMs)],
  [
    "**`kill -9` mid-command**: acknowledged commands lost",
    (rs) =>
      rs.length
        ? rs
            .map(
              (r) =>
                `${r.kill9?.lostAcknowledged ?? "?"}/${r.kill9?.acknowledgedBeforeKill ?? "?"}`,
            )
            .join(", ")
        : "–",
  ],
  [
    "`kill -9`: log consistent, and in-flight retries land exactly once",
    yes(
      (r) =>
        r.kill9?.consistentAfterKill &&
        r.kill9?.exactlyOnceAfterRetry &&
        r.kill9?.consistentAfterRetry,
    ),
  ],
  [
    "`kill -9`: views catch up with no new command (within 90 s)",
    yes((r) => r.kill9?.viewsConvergedWithoutNewCommands),
  ],
  [
    "`kill -9`: accounts whose views waited for their next command",
    (rs) =>
      rs.length
        ? rs.map((r) => r.kill9?.viewsStuckUntilNextCommand ?? "?").join(", ") + " of 10"
        : "–",
  ],
  ["`kill -9`: back up and answering", num((r) => r.kill9?.readyMs)],
  ["**Export** every stream from sequence 0: consistent", yes((r) => r.export?.consistent)],
  ["Export: time for all streams (34 streams, ~906 events)", num((r) => r.export?.ms)],
  ["State on disk while running", num((r) => r.stateOnDiskKiB / 1024, "MiB")],
  ["State on disk after a clean stop", num((r) => r.stateOnDiskAfterStopKiB / 1024, "MiB")],
];

const out = [
  `| ${dirs.length > 1 ? `Median of ${dirs.length} runs (range)` : "One run"} | celld dev --no-watch (Route A) | workerd (Route C) |`,
  `|---|---|---|`,
  `| Serves the bundle alchemy builds, unchanged | ${smokeCell(smoke.celldAsBuilt)} | ${smokeCell(smoke.workerdAsBuilt)} |`,
  `| … with only the terminal shim | ${smokeCell(smoke.celldTerminal)} | n/a |`,
  ...rows.map(([label, cell]) => `| ${label} | ${cell(runs.celld)} | ${cell(runs.workerd)} |`),
];
console.log(out.join("\n"));
