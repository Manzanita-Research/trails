import type { TrailsDb } from "./db"

function identifier(value: string): void {
  if (!value || value.trim() !== value || value.length > 128) {
    throw new Error("capture account and device IDs must be 1..128 trimmed characters")
  }
}

function provider(source: string): void {
  if (source !== "granola" && source !== "midjourney") throw new Error("unsupported capture source")
}

// Local hub-owner operations only. These are deliberately not exposed to collectors over HTTP.
export function assignCaptureAccount(db: TrailsDb, source: string, deviceId: string, accountId: string | null): void {
  provider(source)
  identifier(deviceId)
  if (accountId !== null) identifier(accountId)
  db.sqlite.transaction(() => {
    if (accountId === null) {
      db.sqlite.query("DELETE FROM capture_device_accounts WHERE source = ? AND device_id = ?").run(source, deviceId)
      return
    }
    if (!db.sqlite.query("SELECT 1 FROM hub_credentials WHERE role = 'collector' AND device_id = ?").get(deviceId)) {
      throw new Error("capture account assignment requires a paired device")
    }
    db.sqlite.query(`INSERT INTO capture_device_accounts(source, device_id, account_id) VALUES (?, ?, ?)
      ON CONFLICT(source, device_id) DO UPDATE SET account_id = excluded.account_id`).run(source, deviceId, accountId)
  }).immediate()
}

export function reconcileCaptureAccount(
  db: TrailsDb, captureId: number, ownerDeviceId: string, source: string, accountId: string,
): void {
  provider(source)
  identifier(ownerDeviceId)
  identifier(accountId)
  if (!Number.isSafeInteger(captureId) || captureId < 1) throw new Error("invalid capture ID")
  db.sqlite.transaction(() => {
    if (!db.sqlite.query(`SELECT 1 FROM capture_device_accounts
      WHERE source = ? AND device_id = ? AND account_id = ?`).get(source, ownerDeviceId, accountId)) {
      throw new Error("assign the original owner device to the target account first")
    }
    // Compare the expected owner and legacy scope; never silently merge or replace account records.
    const updated = db.sqlite.query(`UPDATE captures SET account_id = ?
      WHERE id = ? AND source = ? AND owner_machine_id = ? AND account_id = '' RETURNING id`)
      .get(accountId, captureId, source, ownerDeviceId)
    if (!updated) throw new Error("legacy capture does not match the expected owner and source")
    db.sqlite.query("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'state_revision'").run()
  }).immediate()
}
