/**
 * Stands in for `@effect/platform-node-shared/NodeTerminal` inside the Worker
 * bundle. alchemy's Worker bridge provides `NodeServices.layer` to every
 * Worker, and building its terminal calls `process.stdin.once`, which celld
 * reports as "not implemented". A Worker has no terminal, so this one refuses
 * every use instead of touching stdin. Only build.ts wires it in.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Terminal from "effect/Terminal";

const unavailable = Effect.die(new Error("A Worker has no terminal"));

export const make = () =>
  Effect.succeed(
    Terminal.make({
      columns: Effect.succeed(0),
      rows: Effect.succeed(0),
      readInput: unavailable,
      readLine: unavailable,
      display: () => unavailable,
    }),
  );

export const layer = Layer.effect(Terminal.Terminal, make());
