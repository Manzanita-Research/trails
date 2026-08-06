import { Effect } from "effect"
import type { GranolaCollectorConfig } from "../cli/config"
import { runCaptureCollection, type CaptureCollectionResult } from "./captures"
import { GranolaAdapter, type GranolaCommandRunner } from "./granola"
import { runCollection, type CollectionOptions, type CollectionResult } from "./sync"

export interface OneShotCollectionOptions extends CollectionOptions {
  readonly granola: GranolaCollectorConfig | null
  readonly granolaRun?: GranolaCommandRunner
  readonly granolaNow?: () => number
}

export interface OneShotCollectionResult {
  readonly sessions: CollectionResult | null
  readonly granola: CaptureCollectionResult | null
}

export class OneShotCollectionError extends Error {
  readonly _tag = "OneShotCollectionError"
  constructor(
    readonly result: OneShotCollectionResult,
    readonly providerErrors: ReadonlyArray<string>,
  ) {
    super(providerErrors.join("; "))
  }
}

export async function runOneShotCollection(options: OneShotCollectionOptions): Promise<OneShotCollectionResult> {
  const sessionOutcome = await Effect.runPromise(Effect.either(runCollection(options)))
  let granolaOutcome:
    | { readonly _tag: "Left"; readonly left: unknown }
    | { readonly _tag: "Right"; readonly right: CaptureCollectionResult }
    | null = null
  if (options.granola) {
    granolaOutcome = await Effect.runPromise(
      Effect.either(
        runCaptureCollection({
          server: options.server,
          deviceId: options.deviceId,
          deviceName: options.deviceName,
          statePath: options.statePath,
          adapter: new GranolaAdapter(options.granola, {
            run: options.granolaRun,
            now: options.granolaNow,
          }),
        }),
      ),
    )
  }
  const result: OneShotCollectionResult = {
    sessions: sessionOutcome._tag === "Right" ? sessionOutcome.right : null,
    granola: granolaOutcome?._tag === "Right" ? granolaOutcome.right : null,
  }
  const errors: string[] = []
  if (sessionOutcome._tag === "Left") {
    errors.push(`sessions: ${sessionOutcome.left instanceof Error ? sessionOutcome.left.message : "collection failed"}`)
  }
  if (granolaOutcome?._tag === "Left") {
    errors.push(`granola: ${granolaOutcome.left instanceof Error ? granolaOutcome.left.message : "collection failed"}`)
  }
  if (errors.length > 0) throw new OneShotCollectionError(result, errors)
  return result
}
