/**
 * Build the bank Worker the way `alchemy deploy` would, without deploying:
 * alchemy's own rolldown bundler and virtual entry, then a `wrangler.json`
 * for celld (Route A) and a `config.capnp` for workerd (Route C) that list
 * every Durable Object class the Domain Cloudflare platform declares.
 *
 *   node build.ts [--shims terminal,rpc] [--out dist/<name>]
 *
 * With no shims the bundle is exactly what alchemy builds. The shims are the
 * spike's workarounds for celld 0.6.2, each switchable so a later celld or
 * alchemy release can be re-tested without them (see README.md).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import {
  getCompatibility,
  getToolingCompatibility,
} from "alchemy/Cloudflare/Workers/Compatibility";
import { WorkerBundle } from "alchemy/Cloudflare/Workers/Sources/Rolldown";
import type * as Saga from "alchemy/Domain/Saga";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import type * as rolldown from "rolldown";
import { Bank } from "./bank/src/Bank.model.ts";

const here = import.meta.dirname;
const { values: args } = parseArgs({
  options: { shims: { type: "string", default: "" }, out: { type: "string" } },
});
const shims = new Set(args.shims!.split(",").filter(Boolean));
for (const shim of shims) {
  if (!["terminal", "rpc"].includes(shim)) throw new Error(`unknown shim ${shim}`);
}
const outDir = path.resolve(here, args.out ?? (shims.size ? "dist/shimmed" : "dist/as-built"));

/** The script name is part of every Durable Object id on celld: never rename it. */
export const SCRIPT_NAME = "trails-spike-bank";

/**
 * The classes `DomainCloudflare.DurableObjects` declares while the model's
 * Layer is built, named as `alchemy/src/Domain/Cloudflare.ts` and
 * `Cloudflare/Workflows/DurableObjectEngine.ts` name them at the pinned
 * commit. A missing one fails loudly at the first request ("DurableObject 'X'
 * not found"), so drift shows up in the run, not as silent data loss.
 */
const classes = [
  ...Bank.definitions.aggregates.map((a) => `${a.aggregateName}Aggregate`),
  ...Bank.definitions.views.map((v) => `${v.viewName}View`),
  ...Bank.definitions.policies.map((p) => `${p.policyName}Policy`),
  ...Bank.definitions.projections.map((p) => `${p.projectionName}Projection`),
  ...Bank.definitions.streams.map((s) => `${s.streamName}Stream`),
  // `sagas` is a static on the Model class, not in its public type.
  ...(Bank as unknown as { sagas: ReadonlyArray<Saga.Any> }).sagas.map(
    (s) => `${s.workflow._tag.replace(/[^A-Za-z0-9_]/g, "_")}Workflow`,
  ),
];

const main = path.join(here, "server/BankWorker.ts");
const compatibility = getCompatibility({ main } as never);
/**
 * What the runtimes are told: alchemy's own settings for downstream tools,
 * which spell out `nodejs_compat` (Cloudflare turns it on by date). celld
 * 0.6.2 runs the shimmed bundle with or without it.
 */
const runtimeCompatibility = getToolingCompatibility(compatibility, main);

/**
 * Shim "terminal": alchemy's Worker bridge provides Effect's `NodeServices`
 * to every Worker, and building its terminal calls `process.stdin.once`.
 * celld 0.6.2 has no such method (its global `process.stdin` is a plain
 * object, and `node:process`'s throws "not implemented in celld"), so the
 * Worker fails at startup. A Worker has no terminal: swap in one that refuses
 * use (server/shims/NodeTerminal.ts).
 */
const terminalShim: rolldown.Plugin = {
  name: "spike:no-terminal",
  resolveId: (source) =>
    source === "@effect/platform-node-shared/NodeTerminal"
      ? path.join(here, "server/shims/NodeTerminal.ts")
      : null,
};

/** Every RPC method the Domain platform calls on its objects, at the pinned commit. */
const RPC_METHODS = [
  // aggregates, views, policies, projections, streams (Domain/Cloudflare.ts)
  ...["send", "schedule", "state", "after", "receive", "read", "checkpoints", "append", "advance"],
  // saga executions (Cloudflare/Workflows/DurableObjectEngine.ts)
  ...["start", "poll", "deferredDone", "resume", "interrupt", "interruptUnsafe"],
];
/** Handlers the bridge class declares itself. */
const HANDLERS = ["fetch", "alarm", "webSocketMessage", "webSocketClose", "webSocketError"];

/**
 * Shim "rpc": alchemy's DurableObjectBridge returns a `Proxy` from its
 * constructor so any method name reaches the Effect instance. On celld 0.6.2
 * an RPC call into such an object never returns (a plain class works; see
 * probes/). Export a plain class per Durable Object that declares each method
 * and forwards it to the bridge instance.
 */
const rpcShim: rolldown.Plugin = {
  name: "spike:explicit-rpc",
  transform: {
    filter: { id: /^\0virtual:alchemy-entry:/ },
    handler(code) {
      const pattern = /export class (\w+) extends DurableObjectBridge\("(\w+)"\) \{\}/g;
      if (!pattern.test(code)) throw new Error("rpc shim: the virtual entry changed shape");
      return code.replace(pattern, (_, name: string, id: string) => {
        const forward = (method: string) =>
          `  ${method}(...args) { return this.#bridge.${method}(...args); }`;
        return [
          `const ${name}Bridge = DurableObjectBridge(${JSON.stringify(id)});`,
          `export class ${name} extends DurableObject {`,
          `  #bridge;`,
          `  constructor(state, env) { super(state, env); this.#bridge = new ${name}Bridge(state, env); }`,
          ...[...HANDLERS, ...RPC_METHODS].map(forward),
          `}`,
        ].join("\n");
      });
    },
  },
};

const program = Effect.gen(function* () {
  const bundler = yield* WorkerBundle;
  return yield* bundler.build({
    id: "BankWorker",
    main,
    compatibility,
    entry: {
      kind: "effect",
      exports: Object.fromEntries(
        classes.map((name) => [name, { kind: "durableObject" }]),
      ) as never,
    },
    stack: { name: "TrailsSpike", stage: "local" },
    extraOptions: {
      input: {
        plugins: [shims.has("terminal") && terminalShim, shims.has("rpc") && rpcShim].filter(
          (p): p is rolldown.Plugin => p !== false,
        ),
      },
    },
  });
}).pipe(Effect.provide(PlatformServices));

const bundle = await Effect.runPromise(program);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const modules: Array<string> = [];
for (const file of bundle.files) {
  // Source maps stay out of the payload (they embed absolute source paths).
  if (file.path.endsWith(".map")) continue;
  fs.mkdirSync(path.dirname(path.join(outDir, file.path)), { recursive: true });
  fs.writeFileSync(path.join(outDir, file.path), file.content);
  modules.push(file.path);
}
const entry = modules.find((m) => /^(index|main|BankWorker)\.m?js$/.test(m)) ?? modules[0]!;

// Route A: celld reads a plain wrangler config; the bundle is prebuilt.
const wrangler = {
  name: SCRIPT_NAME,
  main: entry,
  no_bundle: true,
  compatibility_date: runtimeCompatibility.date,
  compatibility_flags: runtimeCompatibility.flags,
  durable_objects: { bindings: classes.map((name) => ({ name, class_name: name })) },
  migrations: [{ tag: "v1", new_sqlite_classes: classes }],
};
fs.writeFileSync(path.join(outDir, "wrangler.json"), `${JSON.stringify(wrangler, null, 2)}\n`);

// Route C: workerd, with Durable Object storage on local disk. The port and
// the storage directory are filled in by run.sh (`--socket-addr`,
// `--directory-path`), so this file holds no machine paths.
const capnp = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .bankWorker),
    (name = "do-storage", disk = (writable = true)),
  ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const bankWorker :Workerd.Worker = (
  modules = [
${modules
  .filter((m) => /\.m?js$/.test(m))
  .map((m) => `    (name = ${JSON.stringify(m)}, esModule = embed ${JSON.stringify(m)}),`)
  .join("\n")}
  ],
  compatibilityDate = ${JSON.stringify(runtimeCompatibility.date)},
  compatibilityFlags = [${runtimeCompatibility.flags.map((f) => JSON.stringify(f)).join(", ")}],
  durableObjectNamespaces = [
${classes.map((name) => `    (className = ${JSON.stringify(name)}, uniqueKey = ${JSON.stringify(`${SCRIPT_NAME}-${name}`)}, enableSql = true),`).join("\n")}
  ],
  durableObjectStorage = (localDisk = "do-storage"),
  bindings = [
${classes.map((name) => `    (name = ${JSON.stringify(name)}, durableObjectNamespace = ${JSON.stringify(name)}),`).join("\n")}
  ],
);
`;
fs.writeFileSync(path.join(outDir, "config.capnp"), capnp);

const bytes = modules.reduce((n, m) => n + fs.statSync(path.join(outDir, m)).size, 0);
console.log(
  JSON.stringify({
    outDir: path.relative(process.cwd(), outDir),
    entry,
    modules: modules.length,
    bytes,
    classes: classes.length,
    compatibility: runtimeCompatibility,
    shims: [...shims],
  }),
);
