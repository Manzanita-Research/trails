import { Database } from "bun:sqlite"
import { closeSync, fstatSync } from "node:fs"
import { inspectPrivateFile, openPrivateFile, secureDirectory, UnsafePathError } from "../shared/private-fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { MIGRATIONS } from "./migrations"

export interface TrailsDb {
  readonly sqlite: Database
  readonly path: string
  close(): void
}

export const DEFAULT_DB_PATH = join(homedir(), ".manzanita/trails/trails.sqlite")

function applyMigrations(
  sqlite: Database,
  context: { readonly defaultTimezone: string; readonly now: number },
): void {
  const current = sqlite.query("PRAGMA user_version").get() as { user_version: number }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current.user_version) continue
    sqlite.transaction(() => {
      sqlite.exec(migration.sql)
      migration.afterSql?.(sqlite, context)
      sqlite.exec(`PRAGMA user_version = ${migration.version}`)
    })()
  }
}

function validTimezone(candidate: string | undefined): string {
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate })
      return candidate
    } catch {}
  }
  return "UTC"
}

export function openDatabase(
  path = DEFAULT_DB_PATH,
  options: { readonly defaultTimezone?: string; readonly now?: number } = {},
): TrailsDb {
  const resolvedPath = path === ":memory:" ? path : resolve(path)
  const previousUmask = process.umask(0o077)
  let sqlite: Database
  try {
    if (resolvedPath === ":memory:") {
      sqlite = new Database(resolvedPath, { strict: true })
    } else {
      secureDirectory(dirname(resolvedPath), true)
      // Bun SQLite opens by pathname, not by descriptor. Protect the namespace
      // first, precreate exclusively, and check its inode around SQLite's open.
      // WAL/SHM and rollback journals can also be opened by SQLite.
      for (const suffix of ["-wal", "-shm", "-journal"]) inspectPrivateFile(`${resolvedPath}${suffix}`)
      const fd = openPrivateFile(resolvedPath, "append")
      try {
        const expected = fstatSync(fd)
        sqlite = new Database(resolvedPath, { strict: true })
        try {
          const actual = inspectPrivateFile(resolvedPath)
          if (!actual || actual.dev !== expected.dev || actual.ino !== expected.ino) {
            throw new UnsafePathError(resolvedPath, "database changed while opening")
          }
        } catch (error) {
          sqlite.close()
          throw error
        }
      } finally { closeSync(fd) }
    }
  } finally {
    process.umask(previousUmask)
  }
  try {
    sqlite.exec("PRAGMA journal_mode=WAL")
    sqlite.exec("PRAGMA foreign_keys=ON")
    sqlite.exec("PRAGMA busy_timeout=5000")
    applyMigrations(sqlite, {
      defaultTimezone: validTimezone(
        options.defaultTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
      now: options.now ?? Date.now(),
    })
  } catch (error) {
    sqlite.close()
    throw error
  }
  return {
    sqlite,
    path: resolvedPath,
    close: () => sqlite.close(),
  }
}
