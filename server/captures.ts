import { Effect } from "effect"
import { createHash } from "node:crypto"
import { normalizeCwd } from "../shared/domain"
import type { IngestCaptureV1, IngestCapturesRequestV1 } from "../shared/protocol"
import type { TrailsDb } from "./db"
import type { IngestResult } from "./ingest"
import { CaptureImageValidationError, validateCaptureImages } from "./capture-images"

export class CaptureIngestError extends Error {
  readonly _tag = "CaptureIngestError"
  constructor(readonly cause: unknown) {
    super("capture ingestion failed")
  }
}

type ExistingCapture = {
  readonly id: number
  readonly machine_id: string
  readonly project: string | null
  readonly content_hash: string
}

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

function providerPayload(capture: IngestCaptureV1): IngestCaptureV1["payload"] {
  return capture.payload
}

export function canonicalCaptureJson(capture: IngestCaptureV1): string {
  return JSON.stringify({
    source: capture.source,
    sourceRecordId: capture.sourceRecordId,
    projectHint: capture.projectHint,
    title: capture.title,
    startedAt: capture.startedAt,
    endedAt: capture.endedAt,
    summaryInput: capture.summaryInput,
    attentionMinutes: capture.attentionMinutes,
    payload: providerPayload(capture),
    images: capture.images.map((image) => ({
      index: image.index,
      mime: image.mime,
      width: image.width,
      height: image.height,
      bytes: image.bytes,
    })),
  })
}

export function captureContentHash(capture: IngestCaptureV1): string {
  return sha256(canonicalCaptureJson(capture))
}

export function ingestCaptures(
  db: TrailsDb,
  input: IngestCapturesRequestV1,
  now = Date.now(),
): Effect.Effect<IngestResult, CaptureIngestError | CaptureImageValidationError> {
  return Effect.tryPromise({
    try: () => validateCaptureImages(input),
    catch: (cause) => cause instanceof CaptureImageValidationError ? cause : new CaptureIngestError(cause),
  }).pipe(Effect.flatMap((images) => Effect.try({
    try: () =>
      db.sqlite.transaction(() => {
        const sqlite = db.sqlite
        let accepted = 0
        let unchanged = 0
        let changed = false

        const machine = sqlite.query("SELECT name FROM machines WHERE id = ?").get(input.device.id) as
          | { name: string }
          | null
        if (!machine) {
          sqlite
            .query("INSERT INTO machines(id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
            .run(input.device.id, input.device.name, now, now)
          changed = true
        } else {
          if (machine.name !== input.device.name) {
            sqlite.query("UPDATE machines SET name = ? WHERE id = ?").run(input.device.name, input.device.id)
            changed = true
          }
          sqlite.query("UPDATE machines SET last_seen_at = ? WHERE id = ?").run(now, input.device.id)
        }

        const insertAttention = sqlite.query(
          "INSERT INTO capture_attention(capture_id, utc_minute) VALUES (?, ?)",
        )
        const insertImage = sqlite.query(
          `INSERT INTO capture_images(capture_id, image_index, mime, width, height, bytes, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )

        for (const capture of input.captures) {
          const contentHash = captureContentHash(capture)
          const requestedProject = capture.project === null ? null : normalizeCwd(capture.project)
          const existing = sqlite
            .query(
              "SELECT id, machine_id, project, content_hash FROM captures WHERE source = ? AND source_record_id = ?",
            )
            .get(capture.source, capture.sourceRecordId) as ExistingCapture | null
          const project = requestedProject ?? existing?.project ?? null
          const contentChanged = existing?.content_hash !== contentHash
          const provenanceChanged = existing?.machine_id !== input.device.id
          const attributionChanged = existing ? requestedProject !== null && existing.project !== project : false

          if (existing && !contentChanged && !provenanceChanged && !attributionChanged) {
            unchanged++
            continue
          }

          const payloadJson = JSON.stringify(providerPayload(capture))
          let captureId: number
          if (existing) {
            sqlite
              .query(
                `UPDATE captures SET machine_id = ?, project = ?, project_hint = ?, title = ?, started_at = ?,
                   ended_at = ?, summary_input = ?, provider_payload = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
              )
              .run(
                input.device.id,
                project,
                capture.projectHint,
                capture.title,
                capture.startedAt,
                capture.endedAt,
                capture.summaryInput,
                payloadJson,
                contentHash,
                now,
                existing.id,
              )
            captureId = existing.id
            if (contentChanged) {
              sqlite.query("DELETE FROM capture_attention WHERE capture_id = ?").run(captureId)
              sqlite.query("DELETE FROM capture_images WHERE capture_id = ?").run(captureId)
            }
          } else {
            const inserted = sqlite
              .query(
                `INSERT INTO captures(machine_id, source, source_record_id, project, project_hint, title,
                   started_at, ended_at, summary_input, provider_payload, content_hash, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
              )
              .get(
                input.device.id,
                capture.source,
                capture.sourceRecordId,
                project,
                capture.projectHint,
                capture.title,
                capture.startedAt,
                capture.endedAt,
                capture.summaryInput,
                payloadJson,
                contentHash,
                now,
              ) as { id: number }
            captureId = inserted.id
          }

          if (!existing || contentChanged) {
            for (const utcMinute of capture.attentionMinutes) insertAttention.run(captureId, utcMinute)
            for (const image of capture.images) {
              const bytes = images.get(image.bytes)!
              insertImage.run(
                captureId,
                image.index,
                image.mime,
                image.width,
                image.height,
                bytes,
                sha256(bytes),
              )
            }
          }
          accepted++
          changed = true
        }

        const revisionRow = sqlite.query("SELECT value FROM meta WHERE key = 'state_revision'").get() as {
          value: string
        }
        let revision = Number(revisionRow.value)
        if (changed) {
          revision++
          sqlite.query("UPDATE meta SET value = ? WHERE key = 'state_revision'").run(String(revision))
        }
        return { accepted, unchanged, revision }
      })(),
    catch: (cause) => new CaptureIngestError(cause),
  })))
}
