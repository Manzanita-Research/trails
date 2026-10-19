// Copied from alchemy-run/alchemy at 9e3c058,
// examples/cloudflare-domain/packages/server/src/MfaChallenge.ts (Apache-2.0; see
// ../bank/LICENSE and ../bank/NOTICE). Only the import paths changed.
import { MfaChallenge, MfaRequired } from "../bank/src/MfaChallenge.middleware.ts";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** Demo check: accepts `x-mfa-code: 000000`. Replace with a real TOTP or WebAuthn check. */
export const MfaChallengeLive = Layer.succeed(MfaChallenge, (effect, { headers }) =>
  Option.getOrUndefined(Headers.get(headers, "x-mfa-code")) === "000000"
    ? effect
    : Effect.fail(new MfaRequired()),
);
