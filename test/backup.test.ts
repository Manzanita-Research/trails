import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createBackup, isTrailsBackupName } from "../server/backup"
import { openDatabase, type TrailsDb } from "../server/db"
import { ingestSessions } from "../server/ingest"
import type { IngestRequestV1 } from "../shared/protocol"

const roots = new Set<string>()
const databases = new Set<TrailsDb>()

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "trails-backup-test-"))
  roots.add(root)
  return root
}

function trackedDatabase(path: string) {
  const database = openDatabase(path)
  databases.add(database)
  return database
}

afterEach(async () => {
  for (const database of databases) {
    try {
      database.close()
    } catch {
      // A failed assertion may leave a database that was already closed.
    }
  }
  databases.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const committedInput: IngestRequestV1 = {
  protocolVersion: 1,
  device: { id: "backup-device", name: "Backup Mac" },
  sessions: [
    {
      sourceSessionId: "committed-session",
      source: "claude",
      cwd: "/Users/tester/code/acme/trails",
      branch: null,
      start: "2026-08-03T17:00:00.000Z",
      end: "2026-08-03T17:01:00.000Z",
      events: 3,
      userEvents: 1,
      firstPrompt: "Preserve this committed session",
      activity: [["2026-08-03", 600, 3, 1]],
      digest: "Committed bounded digest",
    },
  ],
}

describe("SQLite backups", () => {
  test("serializes an active WAL into an independently valid snapshot with only committed data", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "live", "trails.sqlite")
    const output = join(root, "exports", "current.sqlite")
    const writer = trackedDatabase(databasePath)

    expect(await Effect.runPromise(ingestSessions(writer, committedInput, 1_700_000_000_000))).toEqual({
      accepted: 1,
      unchanged: 0,
      revision: 1,
    })
    writer.sqlite
      .query("INSERT INTO pocket_items(id, text, created_at) VALUES (?, ?, ?)")
      .run("committed-pocket", "Visible after commit", 1_700_000_000_001)
    writer.sqlite.query("UPDATE meta SET value = '2' WHERE key = 'state_revision'").run()
    expect((await stat(`${databasePath}-wal`)).size).toBeGreaterThan(0)

    await mkdir(join(root, "exports"), { recursive: true })
    await writeFile(output, "old incomplete backup")
    writer.sqlite.exec("BEGIN IMMEDIATE")
    writer.sqlite
      .query("INSERT INTO pocket_items(id, text, created_at) VALUES (?, ?, ?)")
      .run("uncommitted-pocket", "Must not leak", 1_700_000_000_002)

    try {
      expect(await createBackup({ dbPath: databasePath, output })).toBe(output)
      const snapshot = trackedDatabase(output)
      expect(snapshot.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      expect(snapshot.sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get()).toEqual({ value: "2" })
      expect(snapshot.sqlite
        .query("SELECT id, name FROM machines ORDER BY id")
        .all()).toEqual([{ id: "backup-device", name: "Backup Mac" }])
      expect(snapshot.sqlite
        .query("SELECT source_session_id, event_count, first_prompt FROM sessions")
        .all()).toEqual([
        {
          source_session_id: "committed-session",
          event_count: 3,
          first_prompt: "Preserve this committed session",
        },
      ])
      expect(snapshot.sqlite
        .query("SELECT local_date, minute, event_count, user_event_count FROM session_activity")
        .all()).toEqual([
        { local_date: "2026-08-03", minute: 600, event_count: 3, user_event_count: 1 },
      ])
      expect(snapshot.sqlite
        .query("SELECT id, text FROM pocket_items ORDER BY id")
        .all()).toEqual([{ id: "committed-pocket", text: "Visible after commit" }])
    } finally {
      writer.sqlite.exec("ROLLBACK")
    }

    expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect((await readdir(join(root, "exports"))).filter((name) => name.includes(".tmp"))).toEqual([])
    expect(await readFile(output)).not.toEqual(Buffer.from("old incomplete backup"))
  })

  test("atomically replaces an explicit output and validates mutually exclusive destinations", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "trails.sqlite")
    const output = join(root, "snapshot.sqlite")
    const database = trackedDatabase(databasePath)
    database.sqlite
      .query("INSERT INTO custom_engagements(id, name, created_at) VALUES (?, ?, ?)")
      .run("custom:one", "One", 1)
    await writeFile(output, "stale")

    await expect(createBackup({ dbPath: databasePath })).rejects.toThrow("exactly one")
    await expect(createBackup({ dbPath: databasePath, output, outputDir: root })).rejects.toThrow("exactly one")
    await expect(createBackup({ dbPath: databasePath, outputDir: root, retain: 0 })).rejects.toThrow("positive integer")

    expect(await createBackup({ dbPath: databasePath, output })).toBe(output)
    const replacement = trackedDatabase(output)
    expect(replacement.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
    expect(replacement.sqlite.query("SELECT id, name FROM custom_engagements").all()).toEqual([
      { id: "custom:one", name: "One" },
    ])
    expect((await readdir(root)).filter((name) => name.startsWith(`${basename(output)}.`) && name.endsWith(".tmp"))).toEqual([])
  })

  test("retains only the newest matching Trails names and never prunes neighboring files", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "trails.sqlite")
    const backupDirectory = join(root, "backups")
    trackedDatabase(databasePath)
    await mkdir(backupDirectory, { recursive: true })
    const oldBackups = [
      "trails-20240101-010101.sqlite",
      "trails-20240202-020202.sqlite",
      "trails-20240303-030303.sqlite",
    ]
    for (const name of oldBackups) await writeFile(join(backupDirectory, name), name)
    await writeFile(join(backupDirectory, "trails-manual.sqlite"), "manual")
    await writeFile(join(backupDirectory, "trails-20240101-010101.sqlite.bak"), "sidecar")
    await writeFile(join(backupDirectory, "another-app-20240101-010101.sqlite"), "neighbor")

    const created = await createBackup({
      dbPath: databasePath,
      outputDir: backupDirectory,
      retain: 2,
      now: new Date("2026-08-03T04:05:06.000Z"),
    })
    expect(created).toBe(join(backupDirectory, "trails-20260803-040506.sqlite"))
    expect(isTrailsBackupName(created)).toBe(true)
    expect(isTrailsBackupName("trails-manual.sqlite")).toBe(false)

    expect((await readdir(backupDirectory)).sort()).toEqual([
      "another-app-20240101-010101.sqlite",
      "trails-20240101-010101.sqlite.bak",
      "trails-20240303-030303.sqlite",
      "trails-20260803-040506.sqlite",
      "trails-manual.sqlite",
    ])
    expect(await readFile(join(backupDirectory, "trails-manual.sqlite"), "utf8")).toBe("manual")
    expect(await readFile(join(backupDirectory, "another-app-20240101-010101.sqlite"), "utf8")).toBe("neighbor")
    const retained = trackedDatabase(created)
    expect(retained.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
  })

  test("does not run retention when final replacement fails", async () => {
    const root = await temporaryRoot()
    const databasePath = join(root, "trails.sqlite")
    const backupDirectory = join(root, "backups")
    trackedDatabase(databasePath)
    await mkdir(backupDirectory, { recursive: true })
    const oldBackups = ["trails-20240101-010101.sqlite", "trails-20240202-020202.sqlite"]
    for (const name of oldBackups) await writeFile(join(backupDirectory, name), name)
    const blockedName = "trails-20260803-040506.sqlite"
    await mkdir(join(backupDirectory, blockedName))

    await expect(
      createBackup({
        dbPath: databasePath,
        outputDir: backupDirectory,
        retain: 1,
        now: new Date("2026-08-03T04:05:06.000Z"),
      }),
    ).rejects.toThrow()
    for (const name of oldBackups) expect(await readFile(join(backupDirectory, name), "utf8")).toBe(name)
  })
})
