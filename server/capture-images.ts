import {
  ConfigurationFiles,
  initializeImageMagick,
  MagickFormat,
  MagickImage,
} from "@imagemagick/magick-wasm"
import magickWasm from "@imagemagick/magick-wasm/magick.wasm" with { type: "file" }
import {
  CAPTURE_IMAGE_MAX_BYTES,
  CAPTURE_IMAGE_MAX_DIMENSION,
  CAPTURE_IMAGE_MAX_PIXELS,
  CAPTURE_REQUEST_MAX_PIXELS,
} from "../shared/capture-image-limits"
import type { IngestCapturesRequestV1 } from "../shared/protocol"

export class CaptureImageValidationError extends Error {
  readonly _tag = "CaptureImageValidationError"
  constructor() {
    super("capture images must be valid static images within the image limits and match their MIME and dimensions")
  }
}

// WASM keeps the decoder independent of host libraries and embeds in Bun's
// standalone binaries. Only these three coders may read in-memory input.
// ImageMagick uses exclusive area/list resource limits (4 MP and one frame).
let ready: Promise<void> | undefined
function initializeDecoder(): Promise<void> {
  return ready ??= (async () => {
    const files = ConfigurationFiles.default
    files.policy.data = `<policymap>
      <policy domain="delegate" rights="none" pattern="*"/>
      <policy domain="filter" rights="none" pattern="*"/>
      <policy domain="path" rights="none" pattern="*"/>
      <policy domain="coder" rights="none" pattern="*"/>
      <policy domain="coder" rights="read" pattern="{JPEG,PNG,WEBP}"/>
      <policy domain="resource" name="width" value="${CAPTURE_IMAGE_MAX_DIMENSION}"/>
      <policy domain="resource" name="height" value="${CAPTURE_IMAGE_MAX_DIMENSION}"/>
      <policy domain="resource" name="area" value="${CAPTURE_IMAGE_MAX_PIXELS + 1}"/>
      <policy domain="resource" name="list-length" value="2"/>
      <policy domain="resource" name="memory" value="64MiB"/>
      <policy domain="resource" name="map" value="0"/>
      <policy domain="resource" name="disk" value="0"/>
      <policy domain="resource" name="thread" value="1"/>
      <policy domain="system" name="max-memory-request" value="64MiB"/>
    </policymap>`
    await initializeImageMagick(await Bun.file(magickWasm).bytes(), files)
  })()
}

// Check the bounded container as well as decoding: static PNG decoders may
// ignore APNG chunks, and image libraries may tolerate a missing terminator.
function checkContainer(bytes: Buffer): typeof MagickFormat.Png | typeof MagickFormat.Jpeg | typeof MagickFormat.WebP {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    let offset = 8
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset)
      const type = bytes.toString("ascii", offset + 4, offset + 8)
      offset += size + 12
      if (offset > bytes.length || ["acTL", "fcTL", "fdAT"].includes(type)) throw new CaptureImageValidationError()
      if (type === "IEND") {
        if (size !== 0 || offset !== bytes.length) throw new CaptureImageValidationError()
        return MagickFormat.Png
      }
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return MagickFormat.Jpeg
  } else if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new CaptureImageValidationError()
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const type = bytes.toString("ascii", offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      if (type === "ANIM" || type === "ANMF" || (type === "VP8X" && (bytes[offset + 8]! & 2))) {
        throw new CaptureImageValidationError()
      }
      offset += 8 + size + (size % 2)
    }
    if (offset === bytes.length) return MagickFormat.WebP
  }
  throw new CaptureImageValidationError()
}

const mimeByFormat = {
  [MagickFormat.Jpeg]: "image/jpeg",
  [MagickFormat.Png]: "image/png",
  [MagickFormat.WebP]: "image/webp",
}

/** Validate every image, including unchanged captures, before opening a transaction. */
export async function validateCaptureImages(input: IngestCapturesRequestV1): Promise<ReadonlyMap<string, Buffer>> {
  const images = input.captures.flatMap((capture) => capture.images)
  const validated = new Map<string, Buffer>()
  if (!images.length) return validated
  // Initialization failures are server errors, not bad client images.
  await initializeDecoder()
  let pixels = 0
  try {
    for (const image of images) {
      if (image.bytes.length > Math.ceil(CAPTURE_IMAGE_MAX_BYTES / 3) * 4) throw new CaptureImageValidationError()
      const bytes = Buffer.from(image.bytes, "base64")
      if (!bytes.length || bytes.length > CAPTURE_IMAGE_MAX_BYTES || bytes.toString("base64") !== image.bytes) {
        throw new CaptureImageValidationError()
      }
      const format = checkContainer(bytes)
      if (mimeByFormat[format] !== image.mime) throw new CaptureImageValidationError()
      const decoded = MagickImage.create()
      try {
        let warning = false
        decoded.onWarning = () => { warning = true }
        decoded.ping(bytes)
        const cost = decoded.width * decoded.height
        pixels += cost
        if (
          warning || decoded.format !== format ||
          decoded.width !== image.width || decoded.height !== image.height ||
          cost < 1 || cost > CAPTURE_IMAGE_MAX_PIXELS || pixels > CAPTURE_REQUEST_MAX_PIXELS
        ) throw new CaptureImageValidationError()
        // Ping alone cannot detect damaged compressed pixel data.
        decoded.read(bytes)
        if (warning || decoded.format !== format || decoded.width !== image.width || decoded.height !== image.height) {
          throw new CaptureImageValidationError()
        }
      } finally {
        decoded.dispose()
      }
      validated.set(image.bytes, bytes)
    }
  } catch {
    // Do not return decoder diagnostics or embedded metadata to the caller.
    throw new CaptureImageValidationError()
  }
  return validated
}
