import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import {
  CollectorStatusV1Schema,
  IngestSessionV2Schema,
  decodeExact,
  type CollectionMetricsV1,
  type CollectorErrorCode,
  type CollectorStatusV1,
  type IngestSessionV2,
} from "../shared/protocol"
import { parseSessionFile } from "./session"
import { DEFAULT_SOURCE_ROOTS, discoverSourceFiles, type SourceFile, type SourceRoot } from "./sources"
import {
  DEFAULT_STATE_PATH,
  collectorTargetsMatch,
  loadCollectorState,
  saveCollectorState,
  withCollectorLock,
  type CollectorState,
  type CollectorTarget,
  type FileFingerprint,
} from "./state"
import { normalizeCollectorServer } from "../cli/config"
import { abortable, collectorRequest, CYCLE_TIMEOUT_MS, readAcknowledgment, REQUEST_TIMEOUT_MS } from "./http"

export interface CollectionOptions {
  readonly server: string
  readonly deviceId: string
  readonly token: string
  readonly deviceName: string
  readonly statePath?: string
  readonly roots?: ReadonlyArray<SourceRoot>
  readonly fetch?: typeof globalThis.fetch
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly requestTimeoutMs?: number
  readonly cycleTimeoutMs?: number
}

export interface CollectionResult {
  readonly discovered: number
  readonly changed: number
  readonly uploaded: number
  readonly ignored: number
  readonly unchanged: number
  readonly revision: number | null
  readonly errors: ReadonlyArray<string>
}

export class CollectorError extends Error {
  readonly _tag = "CollectorError"
  constructor(readonly result: CollectionResult, readonly firstErrorCode: CollectorErrorCode) {
    super(result.errors[0] ?? "collection failed")
  }
}

type ParsedFile = {
  readonly file: SourceFile
  readonly fingerprint: FileFingerprint
  readonly stable: boolean
  readonly session: IngestSessionV2 | null
  readonly error: string | null
}

function fingerprintOf(info: { readonly size: number; readonly mtimeMs: number }): FileFingerprint {
  return { size: info.size, mtimeMs: info.mtimeMs }
}

function fingerprintsMatch(left: FileFingerprint | undefined, right: FileFingerprint): boolean {
  return left?.size === right.size && left.mtimeMs === right.mtimeMs
}

function inspectChangedFile(file: SourceFile): Effect.Effect<ParsedFile, never> {
  return Effect.gen(function* () {
    const before = yield* Effect.tryPromise(() => stat(file.path))
    const session = yield* parseSessionFile(file.path, file.source)
    const after = yield* Effect.tryPromise(() => stat(file.path))
    const fingerprint = fingerprintOf(after)
    return {
      file,
      fingerprint,
      stable: before.size === after.size && before.mtimeMs === after.mtimeMs,
      session,
      error: null,
    }
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.succeed({
        file,
        fingerprint: { size: 0, mtimeMs: 0 },
        stable: false,
        session: null,
        error: cause instanceof Error ? cause.name : "parse_error",
      }),
    ),
  )
}

async function uploadBatch(
  target: CollectorTarget,
  sessions: ReadonlyArray<IngestSessionV2>,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
  token: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<number> {
  const endpoint = new URL("api/ingest", target.server)
  let lastError = "upload failed"
  for (let attempt = 0; attempt <= 3; attempt++) {
    signal.throwIfAborted()
    try {
      return await collectorRequest(fetcher, endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ protocolVersion: 2, device: { id: target.deviceId, name: target.deviceName }, sessions }),
      }, signal, timeoutMs, async (response, requestSignal) => {
        if (!response.ok) throw new Error(`http_${response.status}`)
        const body = await readAcknowledgment(response, requestSignal)
        if (
          typeof body !== "object" ||
          body === null ||
          !("revision" in body) ||
          !isCount(body.revision) ||
          !("accepted" in body) ||
          !isCount(body.accepted) ||
          !("unchanged" in body) ||
          !isCount(body.unchanged) ||
          body.accepted + body.unchanged !== sessions.length
        ) {
          throw new Error("invalid ingest response")
        }
        return body.revision
      })
    } catch (cause) {
      signal.throwIfAborted()
      lastError = cause instanceof Error ? cause.message : "network_error"
      if (lastError.startsWith("http_") && lastError !== "http_408" && lastError !== "http_429" && !lastError.startsWith("http_5")) throw cause
    }
    if (attempt < 3) await abortable(sleep(2_000 * 2 ** attempt), signal)
  }
  throw new Error(lastError)
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function collectionProgram(
  options: CollectionOptions,
  target: CollectorTarget,
): Effect.Effect<CollectionResult, Error | CollectorError> {
  return Effect.gen(function* () {
    const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH)
    const previous = yield* loadCollectorState(statePath)
    const previousFiles = previous && collectorTargetsMatch(previous.target, target) ? previous.files : {}
    const files = yield* discoverSourceFiles(options.roots ?? DEFAULT_SOURCE_ROOTS)
    const changedFiles: SourceFile[] = []
    const nextFiles: Record<string, FileFingerprint> = {}
    let unchanged = 0
    for (const file of files) {
      const current = yield* Effect.tryPromise(() => stat(file.path))
      const fingerprint = fingerprintOf(current)
      if (fingerprintsMatch(previousFiles[file.path], fingerprint)) {
        nextFiles[file.path] = fingerprint
        unchanged++
      } else {
        changedFiles.push(file)
      }
    }

    const parsed = yield* Effect.forEach(changedFiles, inspectChangedFile, { concurrency: 8 })
    const errors: string[] = []
    let firstErrorCode: CollectorErrorCode | null = null
    let ignored = 0
    for (const item of parsed) {
      if (item.error) {
        errors.push(item.error)
        firstErrorCode ??= "parse_error"
      } else if (!item.stable) {
        errors.push("file_changed_during_read")
        firstErrorCode ??= "file_changed_during_read"
      } else if (item.session === null) {
        nextFiles[item.file.path] = item.fingerprint
        ignored++
      }
    }

    const uploadable = parsed.filter((item): item is ParsedFile & { readonly session: IngestSessionV2 } => item.session !== null)
    const fetcher = options.fetch ?? globalThis.fetch
    const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    let uploaded = 0
    let revision: number | null = null
    for (let index = 0; index < uploadable.length; index += 50) {
      const batch = uploadable.slice(index, index + 50)
      const sessions = batch.map((item) => decodeExact(IngestSessionV2Schema, item.session))
      const outcome = yield* Effect.either(
        Effect.tryPromise({
          try: (signal) => uploadBatch(target, sessions, fetcher, sleep, options.token, signal, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
          catch: (cause) => (cause instanceof Error ? cause : new Error("upload_error")),
        }),
      )
      if (outcome._tag === "Left") {
        errors.push(outcome.left instanceof Error ? outcome.left.message : "upload_error")
        firstErrorCode ??= "upload_error"
        continue
      }
      revision = outcome.right
      uploaded += batch.length
      for (const item of batch) {
        if (item.stable) nextFiles[item.file.path] = item.fingerprint
      }
    }

    const state: CollectorState = { protocolVersion: 2, target, files: nextFiles }
    // Finish an atomic checkpoint before releasing ownership, even on interruption.
    yield* saveCollectorState(statePath, state).pipe(Effect.uninterruptible)
    const result: CollectionResult = {
      discovered: files.length,
      changed: changedFiles.length,
      uploaded,
      ignored,
      unchanged,
      revision,
      errors,
    }
    if (errors.length) return yield* Effect.fail(new CollectorError(result, firstErrorCode ?? "collector_error"))
    return result
  })
}

function collectorTarget(options: CollectionOptions): CollectorTarget {
  if (!/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("collector is not paired; run setup join with --pairing-file")
  const server = normalizeCollectorServer(options.server)
  const deviceId = options.deviceId.trim()
  const deviceName = options.deviceName.trim()
  if (!deviceId || deviceId.length > 128 || !deviceName || deviceName.length > 128) {
    throw new Error("device id and name must be 1..128 characters")
  }
  return { server, deviceId, deviceName }
}

function metricsOf(result: CollectionResult): CollectionMetricsV1 {
  return {
    discovered: result.discovered,
    changed: result.changed,
    uploaded: result.uploaded,
    ignored: result.ignored,
    unchanged: result.unchanged,
  }
}

function collectorErrorCode(error: Error | CollectorError): CollectorErrorCode {
  return error instanceof CollectorError ? error.firstErrorCode : "collector_error"
}

function reportCollectorStatus(
  target: CollectorTarget,
  outcome: CollectorStatusV1["outcome"],
  fetcher: typeof globalThis.fetch,
  token: string,
  timeoutMs: number,
): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async (signal) => {
      const body = decodeExact(CollectorStatusV1Schema, {
        protocolVersion: 1,
        device: { id: target.deviceId, name: target.deviceName },
        outcome,
      })
      await collectorRequest(fetcher, new URL("api/collector-status", target.server), {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }, signal, timeoutMs, async (response) => {
        if (!response.ok) throw new Error(`collector status http_${response.status}`)
      })
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error("collector status failed")),
  })
}

function ownedCollectionProgram(
  options: CollectionOptions,
  target: CollectorTarget,
): Effect.Effect<CollectionResult, Error | CollectorError> {
  return Effect.gen(function* () {
    const outcome = yield* Effect.either(collectionProgram(options, target))
    const fetcher = options.fetch ?? globalThis.fetch
    if (outcome._tag === "Right") {
      yield* reportCollectorStatus(
        target,
        { status: "processed", metrics: metricsOf(outcome.right), error: null },
        fetcher,
        options.token,
        options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      )
      return outcome.right
    }
    const failure = outcome.left
    yield* reportCollectorStatus(
      target,
      {
        status: "failed",
        metrics: failure instanceof CollectorError ? metricsOf(failure.result) : null,
        error: collectorErrorCode(failure),
      },
      fetcher,
      options.token,
      options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    ).pipe(Effect.ignore)
    return yield* Effect.fail(failure)
  })
}

export function runCollection(options: CollectionOptions): Effect.Effect<CollectionResult, Error | CollectorError> {
  return Effect.try({
    try: () => {
      for (const timeout of [options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, options.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS]) {
        if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
          throw new Error("collector timeouts must be positive timer-safe integers")
        }
      }
      return collectorTarget(options)
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.flatMap((target) => {
      const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH)
      return withCollectorLock(statePath, ownedCollectionProgram(options, target).pipe(
        Effect.timeoutFail({
          duration: options.cycleTimeoutMs ?? CYCLE_TIMEOUT_MS,
          onTimeout: () => new Error("collector cycle timed out"),
        }),
      ))
    }),
  )
}
