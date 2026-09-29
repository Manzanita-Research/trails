import { Effect } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bootstrapOf, createApp } from "../server/app"
import { issueCredential } from "../server/auth"
import { ingestCaptures } from "../server/captures"
import { openDatabase } from "../server/db"
import { fixtureImage } from "./capture-image-fixtures"

// Synthetic checked-in PNG; never read an installed hub or real capture.
const fixture = fixtureImage("static.png")
export const cacheFixtureImage = Buffer.from(fixture.bytes, "base64")

export async function cacheFixture(origin = "http://trails.test") {
  const root = await mkdtemp(join(tmpdir(), "trails-cache-"))
  const db = openDatabase(":memory:")
  const close = async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  }
  try {
    await writeFile(join(root, "index.html"), "<!doctype html><title>Cache policy fixture</title>")
    await writeFile(join(root, "app-12345678.js"), "/* public fixture asset */")
    await writeFile(join(root, "plain.css"), "body{}")
    const owner = issueCredential(db, "owner")
    const reader = issueCredential(db, "read")
    const collector = issueCredential(db, "collector", "fixture")
    await Effect.runPromise(ingestCaptures(db, {
      protocolVersion: 1,
      device: { id: "fixture", name: "Fixture" },
      captures: [{
        source: "midjourney", sourceRecordId: "fixture", project: null, projectHint: null,
        title: "Synthetic cache fixture", startedAt: "2026-09-16T12:00:00.000Z", endedAt: null,
        summaryInput: "Synthetic fixture", attentionMinutes: [Date.parse("2026-09-16T12:00:00.000Z") / 60_000],
        payload: { eventType: "imagine", jobType: "generation", parentSourceRecordId: null, parentGrid: null },
        images: [0, 1, 2, 3].map((index) => ({ ...fixture, index })),
      }],
    }, collector))
    const bootstrap = bootstrapOf(db)
    const imageUrl = bootstrap.captures[0]!.images[0]!.url
    const app = createApp({
      db, staticRoot: root, trustedOrigins: [origin],
      harnesses: { activate() {}, disconnect() {}, status: () => ({ protocolVersion: 1, active: null, harnesses: [] }) },
    })
    return { db, app, owner, reader, collector, imageUrl, revision: bootstrap.revision, close }
  } catch (error) {
    await close()
    throw error
  }
}
