import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { atomicWriteJson, configureCollector, loadCollectorConfig, loadHubConfig, writeHubConfig } from "../cli/config"
import { loadCollectorState, saveCollectorState, withCollectorLock, type CollectorState } from "../collector/state"
import { openDatabase } from "../server/db"
import { initializeOwner, ownerTokenPath, rotateOwner } from "../server/auth"
import { atomicWritePrivateFile, createPrivateFile, openPrivateFile, readPrivateFile, secureDirectory } from "../shared/private-fs"

let root: string
let path: string
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "trails-private-fs-"))
  path = join(root, "private.json")
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })
const state: CollectorState = {
  protocolVersion: 2,
  target: { server: "https://hub.example/", deviceId: "id", deviceName: "name" },
  files: {},
}

describe("private filesystem boundary", () => {
  test("rejects writable and readable private directories without silently repairing them", () => {
    for (const mode of [0o777, 0o770, 0o750, 0o755]) {
      fs.chmodSync(root, mode)
      expect(() => atomicWriteJson(path, {})).toThrow("mode 700")
      expect(() => openDatabase(path)).toThrow("mode 700")
      expect(() => openPrivateFile(path, "append")).toThrow("mode 700")
      expect(fs.existsSync(path)).toBe(false)
      expect(fs.statSync(root).mode & 0o777).toBe(mode)
    }
  })

  test("rejects writable ancestors even above an owner-only directory", () => {
    const child = join(root, "child")
    fs.mkdirSync(child, { mode: 0o700 })
    fs.chmodSync(root, 0o770)
    expect(() => atomicWriteJson(join(child, "config.json"), {})).toThrow("ancestor")
    expect(() => loadCollectorConfig(join(child, "missing.json"))).toThrow("ancestor")
  })

  test("allows searchable nonwritable ancestors and creates private nested directories", () => {
    fs.chmodSync(root, 0o755)
    const child = join(root, "nested", "private")
    atomicWriteJson(join(child, "config.json"), { ok: true })
    expect(fs.statSync(child).mode & 0o777).toBe(0o700)
    expect(readPrivateFile(join(child, "config.json"))).toContain('"ok": true')
  })

  test("rejects both unsafe config modes and hub symlinks from the audit", () => {
    const config = configureCollector({ path, server: "https://synthetic.example/" })
    fs.chmodSync(path, 0o666)
    expect(() => loadCollectorConfig(path)).toThrow("owner-only")
    expect(() => atomicWriteJson(path, config)).toThrow("owner-only")
    fs.chmodSync(path, 0o600)
    const hub = join(root, "server.json")
    writeHubConfig(null, hub)
    fs.symlinkSync(hub, join(root, "link.json"))
    expect(() => loadHubConfig(join(root, "link.json"))).toThrow("regular file")
    fs.symlinkSync(join(root, "missing"), join(root, "dangling.json"))
    expect(() => loadHubConfig(join(root, "dangling.json"))).toThrow("regular file")
  })

  test("rejects user-owned directory symlinks, hardlinks, directories and FIFOs", () => {
    const child = join(root, "child")
    fs.mkdirSync(child, { mode: 0o700 })
    fs.symlinkSync(child, join(root, "alias"))
    expect(() => atomicWriteJson(join(root, "alias", "config.json"), {})).toThrow("symlink directory")
    createPrivateFile(path, "secret")
    fs.linkSync(path, join(root, "hardlink"))
    expect(() => readPrivateFile(path)).toThrow("one link")
    expect(() => openPrivateFile(child, "read")).toThrow("regular file")
    const fifo = join(root, "fifo")
    expect(Bun.spawnSync(["mkfifo", "-m", "600", fifo]).exitCode).toBe(0)
    expect(() => readPrivateFile(fifo)).toThrow("regular file")
  })

  test("rejects foreign ownership reported by lstat and by the opened descriptor", () => {
    // Metadata injection exercises foreign UIDs without requiring root/chown.
    createPrivateFile(path, "secret")
    const original = fs.lstatSync
    const mocked = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      const info = original(file)
      if (String(file) === path) info.uid = process.getuid!() + 1
      return info
    }) as typeof fs.lstatSync)
    try { expect(() => readPrivateFile(path)).toThrow("current-user-owned") } finally { mocked.mockRestore() }
    const originalFstat = fs.fstatSync
    const opened = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
      const info = originalFstat(fd)
      info.uid = process.getuid!() + 1
      return info
    }) as typeof fs.fstatSync)
    try { expect(() => readPrivateFile(path)).toThrow("current-user-owned") } finally { opened.mockRestore() }
  })

  test("rejects foreign directory ownership", () => {
    const original = fs.lstatSync
    const mocked = spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike) => {
      const info = original(file)
      if (String(file) === root) info.uid = process.getuid!() + 1
      return info
    }) as typeof fs.lstatSync)
    try { expect(() => secureDirectory(root)).toThrow("owned by the current user") } finally { mocked.mockRestore() }
  })

  test("no-follow blocks a symlink swapped between inspection and append", () => {
    createPrivateFile(path, "original")
    const target = join(root, "victim")
    createPrivateFile(target, "untouched")
    const original = fs.openSync
    const mocked = spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (String(file) === path) {
        fs.unlinkSync(path)
        fs.symlinkSync(target, path)
      }
      return original(file, flags, mode)
    })
    try { expect(() => openPrivateFile(path, "append")).toThrow("symlink") } finally { mocked.mockRestore() }
    expect(fs.readFileSync(target, "utf8")).toBe("untouched")
  })

  test("inode comparison rejects a regular file swapped before open", () => {
    createPrivateFile(path, "original")
    const replacement = join(root, "replacement")
    createPrivateFile(replacement, "replacement")
    const original = fs.openSync
    const mocked = spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      if (String(file) === path) fs.renameSync(replacement, path)
      return original(file, flags, mode)
    })
    try { expect(() => readPrivateFile(path)).toThrow("changed while opening") } finally { mocked.mockRestore() }
  })

  test("rechecks parents after open and closes a rejected descriptor", () => {
    createPrivateFile(path, "secret")
    const original = fs.openSync
    let descriptor = -1
    const mocked = spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const fd = original(file, flags, mode)
      if (String(file) === path) {
        descriptor = fd
        fs.chmodSync(root, 0o777)
      }
      return fd
    })
    try { expect(() => readPrivateFile(path)).toThrow("mode 700") } finally { mocked.mockRestore() }
    expect(() => fs.fstatSync(descriptor)).toThrow()
  })

  test("appends to safe logs without truncation and rejects readable logs", () => {
    createPrivateFile(path, "before")
    const fd = openPrivateFile(path, "append")
    try { fs.writeFileSync(fd, "after") } finally { fs.closeSync(fd) }
    expect(readPrivateFile(path)).toBe("beforeafter")
    fs.chmodSync(path, 0o644)
    expect(() => openPrivateFile(path, "append")).toThrow("owner-only")
    expect(fs.readFileSync(path, "utf8")).toBe("beforeafter")
  })

  test("malformed collector content never appears in configuration errors", () => {
    createPrivateFile(path, '{"token":"synthetic-secret" invalid}')
    try {
      loadCollectorConfig(path)
      throw new Error("expected invalid configuration")
    } catch (error) {
      expect(String(error)).toContain("collector configuration is invalid")
      expect(String(error)).not.toContain("synthetic-secret")
    }
  })

  test("exclusive creation refuses existing files and cleans failed atomic writes", () => {
    createPrivateFile(path, "original")
    expect(() => createPrivateFile(path, "replacement")).toThrow()
    const mocked = spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("synthetic rename failure") })
    try { expect(() => atomicWritePrivateFile(path, "replacement")).toThrow("synthetic") } finally { mocked.mockRestore() }
    expect(readPrivateFile(path)).toBe("original")
    expect(fs.readdirSync(root)).toEqual(["private.json"])
  })

  test("rejects unsafe checkpoints and locks without removing them", async () => {
    await Effect.runPromise(saveCollectorState(path, state))
    fs.chmodSync(path, 0o644)
    await expect(Effect.runPromise(loadCollectorState(path))).rejects.toThrow("owner-only")
    await expect(Effect.runPromise(saveCollectorState(path, state))).rejects.toThrow("owner-only")
    const lock = `${path}.lock`
    fs.symlinkSync(path, lock)
    await expect(Effect.runPromise(withCollectorLock(path, Effect.void))).rejects.toThrow("regular file")
    expect(fs.lstatSync(lock).isSymbolicLink()).toBe(true)
  })

  test("rejects database and sidecar symlinks before SQLite can touch their targets", () => {
    const target = join(root, "target")
    createPrivateFile(target, "untouched")
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const link = `${path}${suffix}`
      fs.symlinkSync(target, link)
      expect(() => openDatabase(path)).toThrow("regular file")
      expect(readPrivateFile(target)).toBe("untouched")
      fs.unlinkSync(link)
    }
    expect(fs.existsSync(path)).toBe(false)
  })

  test("safe upgrades preserve config identity, state, database and credentials", async () => {
    const first = configureCollector({ path, server: "https://hub.example/" })
    expect(configureCollector({ path, server: first.server }).deviceId).toBe(first.deviceId)
    await Effect.runPromise(saveCollectorState(join(root, "state.json"), state))
    expect(await Effect.runPromise(loadCollectorState(join(root, "state.json")))).toEqual(state)
    const dbPath = join(root, "trails.sqlite")
    let db = openDatabase(dbPath)
    initializeOwner(db)
    const token = readPrivateFile(ownerTokenPath(db))
    db.close()
    db = openDatabase(dbPath)
    try {
      initializeOwner(db)
      expect(readPrivateFile(ownerTokenPath(db))).toBe(token)
      rotateOwner(db)
      expect(readPrivateFile(ownerTokenPath(db))).not.toBe(token)
      expect(db.sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" })
      for (const suffix of ["", "-wal", "-shm"]) expect(fs.statSync(`${dbPath}${suffix}`).mode & 0o777).toBe(0o600)
    } finally { db.close() }
  })

  test("root-owned system temporary aliases remain usable", () => {
    // /tmp is a root-owned alias on macOS, a sticky directory on Linux.
    const temp = fs.mkdtempSync("/tmp/trails-private-alias-")
    try {
      atomicWritePrivateFile(join(temp, "file"), "safe")
      expect(readPrivateFile(join(temp, "file"))).toBe("safe")
    } finally { fs.rmSync(temp, { recursive: true, force: true }) }
  })
})
