import { describe, expect, test } from "bun:test"
import { isMissingLaunchdService, normalizeTailscaleService } from "../cli/install"

describe("launchd installation", () => {
  test("treats absent services as an idempotent bootout", () => {
    expect(isMissingLaunchdService("Boot-out failed: 3: No such process\n")).toBe(true)
    expect(isMissingLaunchdService('Could not find service "com.manzanita.trails.server"')).toBe(true)
    expect(isMissingLaunchdService("service not found")).toBe(true)
    expect(isMissingLaunchdService("Boot-out failed: 5: Input/output error\n")).toBe(false)
  })

  test("accepts only explicit svc-prefixed DNS labels", () => {
    expect(normalizeTailscaleService(undefined)).toBeUndefined()
    expect(normalizeTailscaleService("svc:trails")).toBe("svc:trails")
    expect(() => normalizeTailscaleService("trails")).toThrow("svc:<dns-label>")
    expect(() => normalizeTailscaleService("svc:Trails")).toThrow("svc:<dns-label>")
    expect(() => normalizeTailscaleService("svc:-trails")).toThrow("svc:<dns-label>")
  })
})
