import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs"
import { dirname, resolve } from "node:path"

export class UnsafePathError extends Error {
  constructor(path: string, reason: string) {
    super(`Unsafe private path ${path}: ${reason}. Use a real file in a directory owned by your account; remove group/other access (files 600, private directories 700) and group/other write access on ancestors.`)
  }
}

function uid(): number {
  const value = process.getuid?.()
  if (value === undefined) throw new Error("Private filesystem boundaries require POSIX ownership support")
  return value
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

function sameInode(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

// Ancestors may be readable/searchable, but only root or this account may own
// them. Root-owned sticky temporary directories protect each owned child entry.
// Only root-owned system symlinks (e.g. macOS /tmp and /var) are followed, after
// checking their parent and recursively validating their resolved destination.
export function secureDirectory(path: string, create = false, privateDirectory = true): string {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent !== absolute) secureDirectory(parent, create, false)
  let info: Stats
  try { info = lstatSync(absolute) } catch (error) {
    if (!create || !isMissing(error)) throw error
    try { mkdirSync(absolute, { mode: 0o700 }) } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
    info = lstatSync(absolute)
  }
  if (info.isSymbolicLink()) {
    if (privateDirectory || info.uid !== 0) throw new UnsafePathError(absolute, "symlink directory")
    return secureDirectory(realpathSync(absolute), false, false)
  }
  if (!info.isDirectory()) throw new UnsafePathError(absolute, "not a directory")
  if (privateDirectory) {
    if (info.uid !== uid() || (info.mode & 0o077) !== 0) {
      throw new UnsafePathError(absolute, "private directory must be owned by the current user with mode 700")
    }
  } else {
    const trustedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0
    if ((info.uid !== 0 && info.uid !== uid()) || ((info.mode & 0o022) !== 0 && !trustedSticky)) {
      throw new UnsafePathError(absolute, "ancestor is foreign-owned or writable by another user")
    }
  }
  return absolute
}

function validateFile(path: string, info: Stats): void {
  if (!info.isFile() || info.uid !== uid() || (info.mode & 0o077) !== 0 || info.nlink !== 1) {
    throw new UnsafePathError(path, "expected a current-user-owned, owner-only regular file with one link")
  }
}

export function inspectPrivateFile(path: string, privateParent = true): Stats | null {
  path = resolve(path)
  secureDirectory(dirname(path), false, privateParent)
  try {
    const info = lstatSync(path)
    validateFile(path, info)
    return info
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

// Never truncate before validating the opened inode. O_NONBLOCK prevents a
// substituted FIFO from hanging before fstat; O_NOFOLLOW rejects symlink swaps.
export function openPrivateFile(path: string, mode: "read" | "create" | "append", privateParent = true): number {
  path = resolve(path)
  secureDirectory(dirname(path), mode !== "read", privateParent)
  const before = inspectPrivateFile(path, privateParent)
  const flags = mode === "read" ? constants.O_RDONLY
    : mode === "create" || before === null ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_WRONLY | constants.O_APPEND
  let fd: number
  try { fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600) } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new UnsafePathError(path, "symlink encountered while opening")
    }
    throw error
  }
  try {
    const opened = fstatSync(fd)
    validateFile(path, opened)
    const after = inspectPrivateFile(path, privateParent)
    if (!after || !sameInode(opened, after) || (before && !sameInode(before, opened))) {
      throw new UnsafePathError(path, "file changed while opening; retry after checking the path")
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

export function readPrivateFile(path: string): string {
  const fd = openPrivateFile(path, "read")
  try { return readFileSync(fd, "utf8") } finally { closeSync(fd) }
}

export function createPrivateFile(path: string, content: string | Uint8Array): void {
  const fd = openPrivateFile(path, "create")
  try { writeFileSync(fd, content); fsyncSync(fd) } finally { closeSync(fd) }
}

export function atomicWritePrivateFile(path: string, content: string | Uint8Array, privateParent = true): void {
  path = resolve(path)
  secureDirectory(dirname(path), true, privateParent)
  inspectPrivateFile(path, privateParent)
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  const fd = openPrivateFile(temporary, "create", privateParent)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
    inspectPrivateFile(path, privateParent)
    const current = inspectPrivateFile(temporary, privateParent)
    if (!current || !sameInode(current, fstatSync(fd))) throw new UnsafePathError(temporary, "temporary file changed")
    renameSync(temporary, path)
  } finally {
    closeSync(fd)
    try { unlinkSync(temporary) } catch (error) { if (!isMissing(error)) throw error }
  }
}
