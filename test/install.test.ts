import { describe, expect, test } from "bun:test"
import { isMissingLaunchdService } from "../cli/install"

describe("launchd installation", () => {
  test("treats absent services as an idempotent bootout", () => {
    expect(isMissingLaunchdService("Boot-out failed: 3: No such process\n")).toBe(true)
    expect(isMissingLaunchdService('Could not find service "com.manzanita.trails.server"')).toBe(true)
    expect(isMissingLaunchdService("service not found")).toBe(true)
    expect(isMissingLaunchdService("Boot-out failed: 5: Input/output error\n")).toBe(false)
  })
})
