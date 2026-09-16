import { homedir } from "node:os"
import { join } from "node:path"
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs"

function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("unsafe reader credential file")
    }
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}

// Read integrations get a separate credential; never reuse an ingest/owner token.
export function readerToken(server: string, home = homedir()): string | undefined {
  let raw: string
  try { raw = readPrivateFile(join(home, ".config/trails/reader.json")) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
    throw new Error("Cannot read private Trails reader configuration")
  }
  try {
    const config = JSON.parse(raw)
    if (typeof config.server !== "string" || new URL(config.server).href !== new URL(server).href ||
      typeof config.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(config.token)) {
      throw new Error("invalid reader configuration")
    }
    return config.token
  } catch {
    // Do not expose malformed credential content through parser error messages.
    throw new Error("Trails reader credential must be valid and match this exact hub URL")
  }
}
