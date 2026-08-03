import { Effect } from "effect"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import { decodeExact, IngestSessionV1Schema, type IngestSessionV1 } from "../shared/protocol"
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

export interface CollectionOptions {
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
  readonly statePath?: string
  readonly roots?: ReadonlyArray<SourceRoot>
  readonly fetch?: typeof globalThis.fetch
  readonly sleep?: (milliseconds: number) => Promise<void>
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
  constructor(readonly result: CollectionResult) {
    super(result.errors[0] ?? "collection failed")
  }
}

type ParsedFile = {
  readonly file: SourceFile
  readonly fingerprint: FileFingerprint
  readonly stable: boolean
  readonly session: IngestSessionV1 | null
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
  sessions: ReadonlyArray<IngestSessionV1>,
  fetcher: typeof globalThis.fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<number> {
  const endpoint = new URL("api/ingest", target.server)
  let lastError = "upload failed"
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, device: { id: target.deviceId, name: target.deviceName }, sessions }),
      })
      if (response.ok) {
        const body: unknown = await response.json()
        if (
          typeof body !== "object" ||
          body === null ||
          !("revision" in body) ||
          typeof body.revision !== "number"
        ) {
          throw new Error("invalid ingest response")
        }
        return body.revision
      }
      lastError = `http_${response.status}`
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500
      if (!retryable) throw new Error(lastError)
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : "network_error"
      if (lastError.startsWith("http_4") && lastError !== "http_408" && lastError !== "http_429") throw cause
    }
    if (attempt < 3) await sleep(2_000 * 2 ** attempt)
  }
  throw new Error(lastError)
}

function collectionProgram(options: CollectionOptions): Effect.Effect<CollectionResult, Error | CollectorError> {
  return Effect.gen(function* () {
    const server = normalizeCollectorServer(options.server)
    const deviceId = options.deviceId.trim()
    const deviceName = options.deviceName.trim()
    if (!deviceId || deviceId.length > 128 || !deviceName || deviceName.length > 128) {
      return yield* Effect.fail(new Error("device id and name must be 1..128 characters"))
    }
    const target: CollectorTarget = { server, deviceId, deviceName }
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
    let ignored = 0
    for (const item of parsed) {
      if (item.error) {
        errors.push(item.error)
      } else if (!item.stable) {
        errors.push("file_changed_during_read")
      } else if (item.session === null) {
        nextFiles[item.file.path] = item.fingerprint
        ignored++
      }
    }

    const uploadable = parsed.filter((item): item is ParsedFile & { readonly session: IngestSessionV1 } => item.session !== null)
    const fetcher = options.fetch ?? globalThis.fetch
    const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds))
    let uploaded = 0
    let revision: number | null = null
    for (let index = 0; index < uploadable.length; index += 50) {
      const batch = uploadable.slice(index, index + 50)
      const sessions = batch.map((item) => decodeExact(IngestSessionV1Schema, item.session))
      const outcome = yield* Effect.either(
        Effect.tryPromise({
          try: () => uploadBatch(target, sessions, fetcher, sleep),
          catch: (cause) => (cause instanceof Error ? cause : new Error("upload_error")),
        }),
      )
      if (outcome._tag === "Left") {
        errors.push(outcome.left instanceof Error ? outcome.left.message : "upload_error")
        continue
      }
      revision = outcome.right
      uploaded += batch.length
      for (const item of batch) {
        if (item.stable) nextFiles[item.file.path] = item.fingerprint
      }
    }

    const state: CollectorState = { protocolVersion: 1, target, files: nextFiles }
    yield* saveCollectorState(statePath, state)
    const result: CollectionResult = {
      discovered: files.length,
      changed: changedFiles.length,
      uploaded,
      ignored,
      unchanged,
      revision,
      errors,
    }
    if (errors.length) return yield* Effect.fail(new CollectorError(result))
    return result
  })
}

export function runCollection(options: CollectionOptions): Effect.Effect<CollectionResult, Error | CollectorError> {
  const statePath = resolve(options.statePath ?? DEFAULT_STATE_PATH)
  return withCollectorLock(statePath, collectionProgram(options))
}
