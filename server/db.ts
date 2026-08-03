import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { MIGRATIONS } from "./migrations"

export interface TrailsDb {
  readonly sqlite: Database
  readonly path: string
  close(): void
}

export const DEFAULT_DB_PATH = join(homedir(), ".manzanita/trails/trails.sqlite")

function applyMigrations(sqlite: Database): void {
  const current = sqlite.query("PRAGMA user_version").get() as { user_version: number }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current.user_version) continue
    sqlite.transaction(() => {
      sqlite.exec(migration.sql)
      sqlite.exec(`PRAGMA user_version = ${migration.version}`)
    })()
  }
}

export function openDatabase(path = DEFAULT_DB_PATH): TrailsDb {
  const resolvedPath = path === ":memory:" ? path : resolve(path)
  const previousUmask = process.umask(0o077)
  let sqlite: Database
  try {
    if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 })
    sqlite = new Database(resolvedPath, { create: true, strict: true })
    if (resolvedPath !== ":memory:") chmodSync(resolvedPath, 0o600)
  } finally {
    process.umask(previousUmask)
  }
  try {
    sqlite.exec("PRAGMA journal_mode=WAL")
    sqlite.exec("PRAGMA foreign_keys=ON")
    sqlite.exec("PRAGMA busy_timeout=5000")
    applyMigrations(sqlite)
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
