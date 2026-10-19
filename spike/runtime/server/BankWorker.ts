import * as Cloudflare from "alchemy/Cloudflare";
import * as DomainCloudflare from "alchemy/Domain/Cloudflare";
import { Internals } from "alchemy/Domain/Model";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Bank, BankHandlers } from "../bank/src/Bank.model.ts";
import { CustomerApi } from "../bank/src/CustomerApi.api.ts";
import { FraudCheck } from "../bank/src/Fraud/FraudCheck.external.ts";
import { MemoryLedgerStore } from "../bank/src/Ledger/LedgerStore.ts";
import { Payments } from "../bank/src/Settlement/Payments.external.ts";
import { SupportApi } from "../bank/src/SupportApi.api.ts";
import { MfaChallengeLive } from "./MfaChallenge.ts";
import { actorOf, SessionLive } from "./Session.ts";

/** Upstream's stand-in fraud vendor: large withdrawals score as risky. */
const FakeFraudCheck = FraudCheck.toLayer(
  Effect.succeed({
    score: ({ amount }) => Effect.succeed({ risk: amount >= 80_000 ? 0.95 : 0.05 }),
  }),
);

/** Upstream's stand-in payment processor. Nothing leaves the machine. */
const FakePayments = Payments.toLayer(
  Effect.succeed({
    refund: ({ settlementId }) => Effect.succeed({ refundId: `re_${settlementId}` }),
  }),
);

/**
 * The bank on Durable Objects, exactly as upstream hosts it, minus D1 and
 * Stripe: the ledger projection writes to memory (it is outside the event
 * log, and the spike does not measure it).
 */
const BankLive = Layer.mergeAll(SessionLive, MfaChallengeLive).pipe(
  Layer.provideMerge(Bank.layer(BankHandlers)),
  Layer.provideMerge(MemoryLedgerStore),
  Layer.provide(Layer.mergeAll(DomainCloudflare.DurableObjects, FakeFraudCheck, FakePayments)),
);

/**
 * `POST /admin/export` with `{ "streams": ["Account/c-1-main", ...] }`: every
 * event of each stream, from sequence 0, as NDJSON. The Domain has no way to
 * list instances yet (plan §0, gap 1), so the caller names the streams. Agents
 * only; the spike listens on loopback.
 */
const exportRoute = (internals: Internals["Service"]) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const actor = actorOf(request.headers);
    if (Option.isNone(actor) || actor.value._tag !== "Agent") {
      return HttpServerResponse.empty({ status: 401 });
    }
    const body = (yield* request.json.pipe(Effect.orDie)) as {
      readonly streams: ReadonlyArray<string>;
    };
    const lines: Array<string> = [];
    for (const stream of body.streams) {
      const [aggregate, ...rest] = stream.split("/");
      const id = rest.join("/");
      const store = internals.aggregates.get(aggregate!);
      if (store === undefined)
        return HttpServerResponse.text(`No aggregate ${aggregate}`, { status: 400 });
      const { version } = yield* store.state(id);
      lines.push(JSON.stringify({ stream, version }));
      if (version === 0) continue;
      yield* store.tail(id, 0).pipe(
        Stream.takeUntil((event) => event.envelope.seq >= version),
        Stream.runForEach((event) => Effect.sync(() => lines.push(JSON.stringify(event)))),
      );
    }
    return HttpServerResponse.text(`${lines.join("\n")}\n`, {
      contentType: "application/x-ndjson",
    });
  });

export default class BankWorker extends Cloudflare.Worker<BankWorker>()(
  "BankWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const customerApi = yield* CustomerApi;
    const supportApi = yield* SupportApi;
    const internals = yield* Internals;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        if (path === "/health") return HttpServerResponse.text("ok");
        if (path === "/admin/export") return yield* exportRoute(internals);
        if (path.startsWith("/api")) return yield* customerApi.fetch;
        if (path.startsWith("/support")) return yield* supportApi.fetch;
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    };
  }).pipe(Effect.provide(BankLive)),
) {}
