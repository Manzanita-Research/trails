import { readFileSync } from "node:fs"
import type { CaptureImageV1 } from "../shared/protocol"

export function fixtureImage(name = "static.png", overrides: Partial<CaptureImageV1> = {}): CaptureImageV1 {
  const extension = name.split(".").at(-1)
  return {
    index: 0,
    mime: extension === "jpg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "image/png",
    width: 2,
    height: 3,
    bytes: readFileSync(new URL(`./fixtures/capture-images/${name}`, import.meta.url)).toString("base64"),
    ...overrides,
  }
}
