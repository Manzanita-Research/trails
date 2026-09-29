import { describe, expect, test } from "bun:test"
import { fixtureImage } from "./capture-image-fixtures"
import { CaptureImageValidationError, validateCaptureImages } from "../server/capture-images"
import type { CaptureImageV1, IngestCapturesRequestV1 } from "../shared/protocol"

function input(images: readonly CaptureImageV1[]): IngestCapturesRequestV1 {
  return {
    protocolVersion: 1,
    device: { id: "test", name: "Test" },
    captures: [{
      source: "midjourney", sourceRecordId: "test", project: null, projectHint: null,
      title: "Test", summaryInput: "Test", startedAt: "2026-08-03T17:00:00.000Z", endedAt: null,
      attentionMinutes: [1],
      payload: { eventType: "imagine", jobType: "generation", parentSourceRecordId: null, parentGrid: null },
      images,
    }],
  }
}

describe("capture image validation", () => {
  for (const name of ["static.png", "static.jpg", "static.webp"]) {
    test(`fully decodes ${name} and preserves its original bytes`, async () => {
      const image = fixtureImage(name)
      const validated = await validateCaptureImages(input([image]))
      expect(validated.get(image.bytes)).toEqual(Buffer.from(image.bytes, "base64"))
    })

    test(`rejects forged MIME and dimensions for ${name}`, async () => {
      const image = fixtureImage(name)
      for (const invalid of [
        { ...image, mime: image.mime === "image/png" ? "image/jpeg" as const : "image/png" as const },
        { ...image, width: 1, height: 1 },
      ]) {
        await expect(validateCaptureImages(input([invalid]))).rejects.toBeInstanceOf(CaptureImageValidationError)
      }
    })

    test(`rejects truncated ${name}`, async () => {
      const image = fixtureImage(name)
      const bytes = Buffer.from(image.bytes, "base64")
      for (const length of [12, Math.floor(bytes.length / 2), bytes.length - 1]) {
        await expect(validateCaptureImages(input([{ ...image, bytes: bytes.subarray(0, length).toString("base64") }]))).rejects.toBeInstanceOf(CaptureImageValidationError)
      }
    })
  }

  test("rejects text, SVG, noncanonical base64 and oversized compressed input", async () => {
    for (const bytes of [
      Buffer.from("ordinary text").toString("base64"),
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"/>').toString("base64"),
      fixtureImage().bytes + "\n",
      Buffer.alloc(500 * 1024 + 1).toString("base64"),
    ]) {
      await expect(validateCaptureImages(input([fixtureImage("static.png", { bytes })]))).rejects.toBeInstanceOf(CaptureImageValidationError)
    }
  })

  test("rejects APNG and animated WebP before pixel decoding", async () => {
    for (const name of ["animated.png", "animated.webp"]) {
      await expect(validateCaptureImages(input([fixtureImage(name)]))).rejects.toBeInstanceOf(CaptureImageValidationError)
    }
  })

  test("rejects corrupt compressed pixels even with an intact PNG header and terminator", async () => {
    const image = fixtureImage()
    const bytes = Buffer.from(image.bytes, "base64")
    const idat = bytes.indexOf("IDAT")
    bytes[idat + 4] = 0 // invalid zlib header; header-only parsers still accept dimensions
    await expect(validateCaptureImages(input([{ ...image, bytes: bytes.toString("base64") }]))).rejects.toBeInstanceOf(CaptureImageValidationError)
  })

  test("rejects corrupt JPEG and WebP pixels with complete containers", async () => {
    const jpeg = fixtureImage("static.jpg")
    const jpegBytes = Buffer.from(jpeg.bytes, "base64")
    const scan = jpegBytes.indexOf(Buffer.from([0xff, 0xda]))
    const truncatedJpeg = Buffer.concat([jpegBytes.subarray(0, scan + 8), Buffer.from([0xff, 0xd9])])
    await expect(validateCaptureImages(input([{ ...jpeg, bytes: truncatedJpeg.toString("base64") }]))).rejects.toBeInstanceOf(CaptureImageValidationError)

    const webp = fixtureImage("static.webp")
    const truncatedWebp = Buffer.from(Buffer.from(webp.bytes, "base64").subarray(0, 30))
    truncatedWebp.writeUInt32LE(truncatedWebp.length - 8, 4)
    truncatedWebp.writeUInt32LE(truncatedWebp.length - 20, 16)
    await expect(validateCaptureImages(input([{ ...webp, bytes: truncatedWebp.toString("base64") }]))).rejects.toBeInstanceOf(CaptureImageValidationError)
  })

  test("enforces actual pixel limits regardless of claimed dimensions", async () => {
    for (const dimensions of [{ width: 2001, height: 2000 }, { width: 1, height: 1 }]) {
      await expect(validateCaptureImages(input([fixtureImage("over-pixel-limit.png", dimensions)]))).rejects.toBeInstanceOf(CaptureImageValidationError)
    }
  })

  test("accepts the pixel boundaries and rejects the aggregate request budget", async () => {
    const image = fixtureImage("pixel-limit.png", { width: 2000, height: 2000 })
    const boundary = Array.from({ length: 8 }, () => image)
    expect((await validateCaptureImages(input(boundary))).size).toBe(1)
    await expect(validateCaptureImages(input([...boundary, image]))).rejects.toBeInstanceOf(CaptureImageValidationError)
  })
})
