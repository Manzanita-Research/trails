import { Schema } from "effect"
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { decodeExact } from "../shared/protocol"
import type { ProviderId } from "../shared/providers"
import { atomicWriteJson } from "./config"

export interface OauthCredential {
  readonly type: "oauth"
  readonly access: string
  readonly refresh: string
  /** Epoch milliseconds after which `access` must be refreshed. */
  readonly expires: number
  readonly accountId?: string
}

export interface ApiCredential {
  readonly type: "api"
  readonly key: string
}

export type Credential = OauthCredential | ApiCredential

export type CredentialMap = Readonly<Record<string, Credential>>

const nonEmpty = Schema.String.pipe(Schema.minLength(1))

const CredentialSchema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: nonEmpty,
    refresh: nonEmpty,
    expires: Schema.Number,
    accountId: Schema.optional(nonEmpty),
  }),
  Schema.Struct({
    type: Schema.Literal("api"),
    key: nonEmpty,
  }),
)

const AuthFileSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  providers: Schema.Record({ key: Schema.String, value: CredentialSchema }),
})

export const AUTH_PATH = join(homedir(), ".config/trails/auth.json")

const LOCK_STALE_MS = 30_000
const LOCK_RETRY_MS = 100
const LOCK_RETRIES = 50

function assertSafeFile(path: string): void {
  const info = statSync(path)
  const currentUid = process.getuid?.()
  if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
    throw new Error("credential store permissions are unsafe")
  }
}

export function loadCredentials(path = AUTH_PATH): CredentialMap {
  try {
    assertSafeFile(path)
    const decoded = decodeExact(AuthFileSchema, JSON.parse(readFileSync(path, "utf8")))
    return decoded.providers as CredentialMap
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}
    throw new Error("credential store is invalid")
  }
}

export interface LockOptions {
  readonly retries?: number
  readonly retryMs?: number
}

function acquireLock(lockPath: string, options: LockOptions = {}): void {
  const retries = options.retries ?? LOCK_RETRIES
  const retryMs = options.retryMs ?? LOCK_RETRY_MS
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, "wx", 0o600)
      try {
        writeSync(descriptor, `${process.pid}\n`)
      } finally {
        closeSync(descriptor)
      }
      return
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      try {
        const info = statSync(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        continue
      }
      Bun.sleepSync(retryMs)
    }
  }
  throw new Error("credential store is locked")
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    // already gone; nothing to release
  }
}

/**
 * Serialized read-modify-write over the credential store. The lock guards the
 * two concurrent writers (server token refresh and CLI login/logout) so a
 * rotated refresh token is never lost to a stale overwrite.
 */
export function modifyCredentials(
  mutate: (providers: Record<string, Credential>) => void,
  path = AUTH_PATH,
  lock: LockOptions = {},
): CredentialMap {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const lockPath = `${path}.lock`
  acquireLock(lockPath, lock)
  try {
    const providers: Record<string, Credential> = { ...loadCredentials(path) }
    mutate(providers)
    atomicWriteJson(path, { protocolVersion: 1, providers })
    return providers
  } finally {
    releaseLock(lockPath)
  }
}

export function getCredential(provider: ProviderId, path = AUTH_PATH): Credential | null {
  return loadCredentials(path)[provider] ?? null
}

export function setCredential(provider: ProviderId, credential: Credential, path = AUTH_PATH): void {
  modifyCredentials((providers) => {
    providers[provider] = credential
  }, path)
}

export function removeCredential(provider: ProviderId, path = AUTH_PATH): boolean {
  let removed = false
  modifyCredentials((providers) => {
    removed = provider in providers
    delete providers[provider]
  }, path)
  return removed
}
