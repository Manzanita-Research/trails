import { Effect } from "effect"
import { resolve } from "node:path"
import { normalizeCollectorServer } from "../cli/config"
import {
  IngestCaptureV1Schema,
  decodeExact,
  type CaptureSourceV1,
  type IngestCaptureV1,
} from "../shared/protocol"
import {
  DEFAULT_STATE_PATH,
  collectorTargetsMatch,
  loadCollectorState,
  saveCollectorState,
  withCollectorLock,
  type CollectorState,
  type CollectorTarget,
} from "./state"

const MAX_CAPTURES_PER_REQUEST = 20
const MAX_REQUEST_BYTES = 5 * 1024 * 1024

export type CaptureFetcher = (input: URL | string | Request, init?: RequestInit) => Promise<Response>

export interface CaptureAdapter {
  readonly source: CaptureSourceV1
  collect(cursor: string | null): Promise<{
    readonly captures: ReadonlyArray<IngestCaptureV1>
    readonly nextCursor: string | null
  }>
}

export interface CaptureCollectionOptions {
  readonly adapter: CaptureAdapter
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
  readonly statePath?: string
  readonly fetch?: CaptureFetcher
  readonly sleep?: (milliseconds: number) => Promise<void>
}

export interface CaptureCollectionResult {
  readonly source: CaptureSourceV1
  readonly collected: number
  readonly uploaded: number
  readonly batches: number
  readonly revision: number | null
  readonly nextCursor: string | null
}

export class CaptureCollectionError extends Error {
  readonly _tag = "CaptureCollectionError"
  constructor(
    readonly source: CaptureSourceV1,
    message: string,
  ) {
    super(`${source}: ${message}`)
  }
}

class NonRetryableUploadError extends Error {}

type CaptureBatch = {
  readonly captures: ReadonlyArray<IngestCaptureV1>
  readonly body: string
}

function requestBody(target: CollectorTarget, captures: ReadonlyArray<IngestCaptureV1>): string {
  return JSON.stringify({
    protocolVersion: 1,
    device: { id: target.deviceId, name: target.deviceName },
    captures,
  })
}

function serializedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function packCaptureBatches(
  target: CollectorTarget,
  captures: ReadonlyArray<IngestCaptureV1>,
): ReadonlyArray<CaptureBatch> {
  const batches: CaptureBatch[] = []
  let pending: IngestCaptureV1[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    batches.push({ captures: pending, body: requestBody(target, pending) })
    pending = []
  }

  for (const capture of captures) {
    const singleBody = requestBody(target, [capture])
    if (serializedBytes(singleBody) >= MAX_REQUEST_BYTES) {
      throw new Error(`capture ${capture.sourceRecordId} cannot fit in a 5 MiB request`)
    }
    const candidate = [...pending, capture]
    const candidateBody = requestBody(target, candidate)
    if (candidate.length > MAX_CAPTURES_PER_REQUEST || serializedBytes(candidateBody) >= MAX_REQUEST_BYTES) {
      flush()
      pending = [capture]
    } else {
      pending = candidate
    }
  }
  flush()
  return batches
}

async function uploadCaptureBatch(
  target: CollectorTarget,
  batch: CaptureBatch,
  fetcher: CaptureFetcher,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
  const endpoint = new URL("api/captures", target.server)
  let lastError = "upload failed"
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: batch.body,
      })
      if (!response.ok) {
        lastError = `http_${response.status}`
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500
        if (!retryable) throw new NonRetryableUploadError(lastError)
      } else {
        const body: unknown = await response.json()
        if (
          typeof body !== "object" ||
          body === null ||
          !("accepted" in body) ||
          !("unchanged" in body) ||
          !("revision" in body) ||
          !Number.isInteger(body.accepted) ||
          !Number.isInteger(body.unchanged) ||
          !Number.isInteger(body.revision) ||
          (body.accepted as number) < 0 ||
          (body.unchanged as number) < 0 ||
          (body.revision as number) < 0 ||
          (body.accepted as number) + (body.unchanged as number) !== batch.captures.length
        ) {
          throw new NonRetryableUploadError("invalid capture ingest response")
        }
        return body.revision as number
      }
    } catch (cause) {
      if (cause instanceof NonRetryableUploadError) throw cause
      lastError = cause instanceof Error ? cause.message : "network_error"
    }
    if (attempt < 2) await sleep(2_000 * 2 ** attempt)
  }
  throw new Error(lastError)
}

function captureCollectionProgram(
  options: CaptureCollectionOptions,
): Effect.Effect<CaptureCollectionResult, Error | CaptureCollectionError> {
  return Effect.gen(function* () {
    const server = normalizeCollectorServer(options.server)
    const deviceId = options.deviceId.trim()
    const deviceName = options.deviceName.trim()
    if (!deviceId || deviceId.length > 128 || !deviceName || deviceName.length > 128) {
      return yield* Effect.fail(new Error("device id and name must be 1..128 characters"))
    }
    if (options.adapter.source !== "midjourney" && options.adapter.source !== "granola") {
      return yield* Effect.fail(new Error("unsupported capture source"))
    }

    const target: CollectorTarget = { server, deviceId, deviceName }
    const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH)
    const previous = yield* loadCollectorState(statePath)
    const sameTarget = previous !== null && collectorTargetsMatch(previous.target, target)
    const state: CollectorState = sameTarget
      ? previous
      : {
          protocolVersion: 3,
          target,
          files: {},
          captureCursors: { midjourney: null, granola: null },
        }
    const cursor = state.captureCursors[options.adapter.source]
    const collected = yield* Effect.tryPromise({
      try: () => options.adapter.collect(cursor),
      catch: (cause) =>
        new CaptureCollectionError(
          options.adapter.source,
          cause instanceof Error ? cause.message : "adapter collection failed",
        ),
    })
    if (collected.nextCursor !== null && typeof collected.nextCursor !== "string") {
      return yield* Effect.fail(new CaptureCollectionError(options.adapter.source, "adapter returned an invalid cursor"))
    }

    let captures: IngestCaptureV1[]
    try {
      captures = collected.captures.map((capture) => {
        const decoded = decodeExact(IngestCaptureV1Schema, capture)
        if (decoded.source !== options.adapter.source) throw new Error("adapter returned a capture for another source")
        return decoded
      })
    } catch (cause) {
      return yield* Effect.fail(
        new CaptureCollectionError(
          options.adapter.source,
          cause instanceof Error ? cause.message : "adapter returned an invalid capture",
        ),
      )
    }

    let batches: ReadonlyArray<CaptureBatch>
    try {
      batches = packCaptureBatches(target, captures)
    } catch (cause) {
      return yield* Effect.fail(
        new CaptureCollectionError(options.adapter.source, cause instanceof Error ? cause.message : "capture is too large"),
      )
    }

    const fetcher = options.fetch ?? globalThis.fetch
    const sleep = options.sleep ?? ((milliseconds: number) => Bun.sleep(milliseconds))
    let revision: number | null = null
    for (const batch of batches) {
      const outcome = yield* Effect.either(
        Effect.tryPromise({
          try: () => uploadCaptureBatch(target, batch, fetcher, sleep),
          catch: (cause) =>
            new CaptureCollectionError(
              options.adapter.source,
              cause instanceof Error ? cause.message : "capture upload failed",
            ),
        }),
      )
      if (outcome._tag === "Left") return yield* Effect.fail(outcome.left)
      revision = outcome.right
    }

    const nextState: CollectorState = {
      protocolVersion: 3,
      target,
      files: state.files,
      captureCursors: {
        ...state.captureCursors,
        [options.adapter.source]: collected.nextCursor,
      },
    }
    yield* saveCollectorState(statePath, nextState)
    return {
      source: options.adapter.source,
      collected: captures.length,
      uploaded: captures.length,
      batches: batches.length,
      revision,
      nextCursor: collected.nextCursor,
    }
  })
}

export function runCaptureCollection(
  options: CaptureCollectionOptions,
): Effect.Effect<CaptureCollectionResult, Error | CaptureCollectionError> {
  const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH)
  return withCollectorLock(statePath, captureCollectionProgram(options))
}
