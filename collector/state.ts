import { Effect, Schema } from "effect"
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises"
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
  readonly protocolVersion: 3
  readonly target: CollectorTarget
  readonly files: Record<string, FileFingerprint>
  readonly captureCursors: {
    readonly midjourney: string | null
    readonly granola: string | null
  }
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
const CollectorStateV2Schema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  target: TargetSchema,
  files: Schema.Record({ key: Schema.String, value: FingerprintSchema }),
})
const LegacyCollectorStateSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  target: TargetSchema,
  files: Schema.Record({ key: Schema.String, value: FingerprintSchema }),
})
const CollectorStateSchema = Schema.Struct({
  protocolVersion: Schema.Literal(3),
  target: TargetSchema,
  files: Schema.Record({ key: Schema.String, value: FingerprintSchema }),
  captureCursors: Schema.Struct({
    midjourney: Schema.NullOr(Schema.String),
    granola: Schema.NullOr(Schema.String),
  }),
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
        const input: unknown = JSON.parse(await readFile(path, "utf8"))
        try {
          return decodeExact(CollectorStateSchema, input) as CollectorState
        } catch {
          try {
            decodeExact(LegacyCollectorStateSchema, input)
            return null
          } catch {
            // Version two already contains canonical UTC fingerprints and can be upgraded in place.
          }
          const previous = decodeExact(CollectorStateV2Schema, input)
          return {
            protocolVersion: 3,
            target: previous.target,
            files: previous.files,
            captureCursors: { midjourney: null, granola: null },
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
      const absolute = resolve(path)
      await mkdir(dirname(absolute), { recursive: true, mode: 0o700 })
      const temporary = `${absolute}.${process.pid}.${crypto.randomUUID()}.tmp`
      const handle = await open(temporary, "wx", 0o600)
      try {
        await handle.writeFile(JSON.stringify(decodeExact(CollectorStateSchema, state)))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await chmod(temporary, 0o600)
      await rename(temporary, absolute)
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
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const handle = await open(path, "wx", 0o600)
          try {
            await handle.writeFile(String(process.pid))
            await handle.sync()
          } finally {
            await handle.close()
          }
          return
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
          let owner = 0
          try {
            owner = Number((await readFile(path, "utf8")).trim())
          } catch {}
          if (pidIsAlive(owner)) throw new CollectorBusyError()
          await rm(path, { force: true })
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
    () => Effect.promise(() => rm(lockPath, { force: true })),
  )
}
