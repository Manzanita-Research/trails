import { createHash, randomBytes } from "node:crypto"
import { constants, closeSync, fstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import type { TrailsDb } from "./db"

export type Credential = { id: string; role: "owner" | "read" | "collector"; deviceId: string | null }
const digest = (token: string) => createHash("sha256").update(token).digest("hex")
const secret = () => randomBytes(32).toString("base64url")

export function issueCredential(db: TrailsDb, role: Credential["role"], deviceId: string | null = null) {
  if (role === "collector" && (!deviceId || deviceId.trim() !== deviceId || deviceId.length > 128)) {
    throw new Error("collector credential requires a device ID of 1..128 characters")
  }
  if (role !== "collector" && deviceId !== null) throw new Error("only collectors have a device ID")
  const credential = { id: crypto.randomUUID(), role, deviceId }
  const token = secret()
  db.sqlite.query("INSERT INTO hub_credentials(id, token_hash, role, device_id) VALUES (?, ?, ?, ?)")
    .run(credential.id, digest(token), role, deviceId)
  return { ...credential, token }
}

export function credentialFor(db: TrailsDb, token: string): Credential | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  return db.sqlite.query("SELECT id, role, device_id AS deviceId FROM hub_credentials WHERE token_hash = ?")
    .get(digest(token)) as Credential | null
}

export function revokeCredential(db: TrailsDb, id: string): void {
  const removed = db.sqlite.query("DELETE FROM hub_credentials WHERE id = ? AND role != 'owner' RETURNING id").get(id)
  if (!removed) throw new Error("credential not found; use auth rotate-owner to revoke owner access")
}

export function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
      throw new Error("credential file must be owned by the current user with mode 600")
    }
    return readFileSync(fd, "utf8")
  } finally { closeSync(fd) }
}

export function ownerTokenPath(db: TrailsDb): string { return `${db.path}.owner-token` }

// Bootstrap only from the owning OS account, never from a first network caller.
export function initializeOwner(db: TrailsDb): void {
  if (db.path === ":memory:") throw new Error("owner bootstrap requires a persistent database")
  db.sqlite.transaction(() => {
    if (db.sqlite.query("SELECT id FROM hub_credentials WHERE role = 'owner'").get()) return
    let token: string
    try { token = readPrivateFile(ownerTokenPath(db)).trim() }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
      token = secret()
      writeFileSync(ownerTokenPath(db), `${token}\n`, { flag: "wx", mode: 0o600 })
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid owner credential file")
    db.sqlite.query("INSERT INTO hub_credentials(id, token_hash, role, device_id) VALUES (?, ?, 'owner', NULL)")
      .run(crypto.randomUUID(), digest(token))
  }).immediate()
}

export function rotateOwner(db: TrailsDb): void {
  db.sqlite.transaction(() => {
    const token = secret()
    const path = ownerTokenPath(db)
    try { readPrivateFile(path) } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
    }
    const temporary = `${path}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, `${token}\n`, { flag: "wx", mode: 0o600 })
    renameSync(temporary, path)
    db.sqlite.query("DELETE FROM hub_credentials WHERE role = 'owner'").run()
    db.sqlite.query("INSERT INTO hub_credentials(id, token_hash, role, device_id) VALUES (?, ?, 'owner', NULL)")
      .run(crypto.randomUUID(), digest(token))
  }).immediate()
}

export function createAuthentication(db: TrailsDb, secureAuthorities: ReadonlySet<string>) {
  const sessions = new Map<string, { credentialId: string; expires: number }>()
  const cookieName = (url: URL) => secureAuthorities.has(url.host.toLowerCase()) ? "__Host-trails-session" : "trails-session"
  const cookie = (url: URL, token: string, age: number) =>
    `${cookieName(url)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secureAuthorities.has(url.host.toLowerCase()) ? "; Secure" : ""}`
  const sessionToken = (request: Request, url: URL) => request.headers.get("cookie")?.split(";")
    .map(part => part.trim()).find(part => part.startsWith(`${cookieName(url)}=`))?.split("=")[1]
  return {
    authenticate(request: Request, url: URL, now: number): Credential | null {
      const authorization = request.headers.get("authorization")
      if (authorization !== null) return credentialFor(db, authorization.startsWith("Bearer ") ? authorization.slice(7) : "")
      const token = sessionToken(request, url)
      const session = token ? sessions.get(token) : undefined
      if (!session) return null
      if (session.expires <= now) { sessions.delete(token!); return null }
      // Require Origin on cookie-authenticated writes even for clients without Fetch Metadata.
      if (!["GET", "HEAD"].includes(request.method) && !request.headers.has("origin")) return null
      return db.sqlite.query("SELECT id, role, device_id AS deviceId FROM hub_credentials WHERE id = ?")
        .get(session.credentialId) as Credential | null
    },
    login(credential: Credential, url: URL, now: number): string {
      for (const [token, session] of sessions) if (session.expires <= now) sessions.delete(token)
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!)
      const token = secret()
      sessions.set(token, { credentialId: credential.id, expires: now + 12 * 60 * 60_000 })
      return cookie(url, token, 12 * 60 * 60)
    },
    logout(request: Request, url: URL): string {
      const token = sessionToken(request, url)
      if (token) sessions.delete(token)
      return cookie(url, "", 0)
    },
  }
}
