import { Effect, Schema } from "effect"
import { unlinkSync } from "node:fs"
import { atomicWritePrivateFile, createPrivateFile, inspectPrivateFile, readPrivateFile, secureDirectory } from "../shared/private-fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { decodeExact } from "../shared/protocol"

export interface CollectorTarget {
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
}

export interface FileFingerprint {
  readonly size: number
  readonly mtimeMs: number
}

export interface CollectorState {
  readonly protocolVersion: 2
  readonly target: CollectorTarget
  readonly files: Record<string, FileFingerprint>
}

const TargetSchema = Schema.Struct({
  server: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
})
const FingerprintSchema = Schema.Struct({
  size: Schema.Number.pipe(Schema.nonNegative()),
  mtimeMs: Schema.Number.pipe(Schema.nonNegative()),
})
const CollectorStateSchema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  target: TargetSchema,
  files: Schema.Record({ key: Schema.String, value: FingerprintSchema }),
})
const LegacyCollectorStateSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  target: TargetSchema,
  files: Schema.Record({ key: Schema.String, value: FingerprintSchema }),
})

export const DEFAULT_STATE_PATH = join(homedir(), ".local/state/trails/collector-state.json")

export class CollectorBusyError extends Error {
  readonly _tag = "CollectorBusyError"
  readonly code = "collector_busy"
  constructor() {
    super("another collector process is already running")
  }
}

export function collectorTargetsMatch(left: CollectorTarget, right: CollectorTarget): boolean {
  return left.server === right.server && left.deviceId === right.deviceId && left.deviceName === right.deviceName
}

export function loadCollectorState(path: string): Effect.Effect<CollectorState | null, Error> {
  return Effect.tryPromise({
    try: async () => {
      try {
        const input: unknown = JSON.parse(readPrivateFile(path))
        try {
          return decodeExact(CollectorStateSchema, input) as CollectorState
        } catch (error) {
          try {
            decodeExact(LegacyCollectorStateSchema, input)
            return null
          } catch {
            throw error
          }
        }
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
        throw error
      }
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

export function saveCollectorState(path: string, state: CollectorState): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      atomicWritePrivateFile(resolve(path), JSON.stringify(state))
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

function acquireLock(path: string): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: async () => {
      secureDirectory(dirname(path), true)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          createPrivateFile(path, String(process.pid))
          return
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
          const owner = Number(readPrivateFile(path).trim())
          if (pidIsAlive(owner)) throw new CollectorBusyError()
          inspectPrivateFile(path)
          unlinkSync(path)
        }
      }
      throw new CollectorBusyError()
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}

export function withCollectorLock<A, E>(
  statePath: string,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E | Error> {
  const lockPath = `${resolve(statePath)}.lock`
  return Effect.acquireUseRelease(
    acquireLock(lockPath),
    () => effect,
    () => Effect.sync(() => {
      if (inspectPrivateFile(lockPath)) unlinkSync(lockPath)
    }),
  )
}
