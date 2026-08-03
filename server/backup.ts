import { chmod, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { DEFAULT_DB_PATH, openDatabase } from "./db"

export interface BackupOptions {
  readonly dbPath?: string
  readonly output?: string
  readonly outputDir?: string
  readonly retain?: number
  readonly now?: Date
}

const BACKUP_NAME = /^trails-\d{8}-\d{6}\.sqlite$/

function scheduledName(now: Date): string {
  return `trails-${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}.sqlite`
}

export async function createBackup(options: BackupOptions): Promise<string> {
  if ((options.output ? 1 : 0) + (options.outputDir ? 1 : 0) !== 1) {
    throw new Error("backup requires exactly one of output or outputDir")
  }
  const retain = options.retain ?? 14
  if (!Number.isInteger(retain) || retain < 1) throw new Error("retain must be a positive integer")
  const outputPath = resolve(options.output ?? join(options.outputDir!, scheduledName(options.now ?? new Date())))
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
  const database = openDatabase(options.dbPath ?? process.env.TRAILS_DB_PATH ?? DEFAULT_DB_PATH)
  let serialized: Uint8Array
  try {
    serialized = database.sqlite.serialize()
  } finally {
    database.close()
  }
  const temporary = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(serialized)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, outputPath)

  if (options.outputDir) {
    const directory = resolve(options.outputDir)
    const matching = (await readdir(directory))
      .filter((name) => BACKUP_NAME.test(name))
      .sort()
      .reverse()
    for (const name of matching.slice(retain)) await rm(join(directory, name))
  }
  return outputPath
}

export function isTrailsBackupName(path: string): boolean {
  return BACKUP_NAME.test(basename(path))
}
