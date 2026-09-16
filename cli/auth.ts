import { createPrivateFile } from "../shared/private-fs"
import { DEFAULT_DB_PATH, openDatabase } from "../server/db"
import { initializeOwner, issueCredential, ownerTokenPath, readPrivateFile, revokeCredential, rotateOwner } from "../server/auth"
import { normalizeCollectorServer } from "./config"

export function runAuthCommand(args: string[]): void {
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined
  const db = openDatabase(value("--db") ?? process.env.TRAILS_DB_PATH ?? DEFAULT_DB_PATH)
  try {
    initializeOwner(db)
    if (args[0] === "owner") {
      console.log(readPrivateFile(ownerTokenPath(db)).trim())
    } else if (args[0] === "rotate-owner") {
      rotateOwner(db)
      console.log("Owner credential rotated; browser sessions are revoked. Use trails auth owner to sign in again.")
    } else if (args[0] === "list") {
      console.log(JSON.stringify(db.sqlite.query("SELECT id, role, device_id AS deviceId FROM hub_credentials").all(), null, 2))
    } else if (args[0] === "revoke") {
      if (!args[1]) throw new Error("auth revoke requires the credential ID from auth list")
      revokeCredential(db, args[1])
      console.log("Credential revoked. Stored timeline data is retained.")
    } else if (args[0] === "pair" || args[0] === "read") {
      const output = value("--output")
      const server = value("--server")
      if (!output || !server) throw new Error("auth pair/read requires --server URL and --output FILE")
      const normalized = normalizeCollectorServer(server)
      const collector = args[0] === "pair"
      const deviceId = collector ? value("--device-id") ?? crypto.randomUUID() : null
      const deviceName = value("--name") ?? "Collector"
      if (!deviceName.trim() || deviceName.length > 128) throw new Error("name must be 1..128 characters")
      db.sqlite.transaction(() => {
        const credential = issueCredential(db, collector ? "collector" : "read", deviceId)
        const config = collector
          ? { protocolVersion: 1, server: normalized, deviceId, deviceName, token: credential.token }
          : { server: normalized, token: credential.token }
        // Refuse to overwrite another credential/config file.
        createPrivateFile(output, JSON.stringify(config, null, 2) + "\n")
        console.log(`Created ${credential.role} credential ${credential.id}. Transfer ${output} privately.`)
      })()
    } else {
      throw new Error("auth requires owner | rotate-owner | list | revoke ID | pair --server URL --output FILE [--device-id ID] [--name NAME] | read --server URL --output FILE")
    }
  } finally { db.close() }
}
