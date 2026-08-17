import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMissingLaunchdService, normalizeTailscaleService, retireLegacyProviderConfig } from "../cli/install"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

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

describe("provider credential retirement", () => {
  test("removes only exact owner-only legacy credentials and rewrites exact V2 config", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-retire-provider-"))
    roots.push(root)
    const authPath = join(root, "auth.json")
    const configPath = join(root, "server.json")
    writeFileSync(authPath, JSON.stringify({
      protocolVersion: 1,
      providers: {
        openrouter: { type: "api", key: "private-key" },
        chatgpt: { type: "oauth", access: "access", refresh: "refresh", expires: 1, accountId: "account" },
      },
    }), { mode: 0o600 })
    writeFileSync(configPath, JSON.stringify({
      protocolVersion: 2,
      summarizer: { provider: "chatgpt", model: "gpt-5.2-codex" },
    }), { mode: 0o600 })

    expect(await retireLegacyProviderConfig({ authPath, configPath })).toBe(true)
    expect(existsSync(authPath)).toBe(false)
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({ protocolVersion: 3, summarizer: null })
  })

  test("refuses symlinks, unsafe modes, and unrecognized credential content", async () => {
    const root = mkdtempSync(join(tmpdir(), "trails-retire-provider-"))
    roots.push(root)
    const configPath = join(root, "server.json")
    writeFileSync(configPath, JSON.stringify({ protocolVersion: 3, summarizer: null }), { mode: 0o600 })
    const target = join(root, "target.json")
    writeFileSync(target, JSON.stringify({ protocolVersion: 1, providers: {} }), { mode: 0o600 })
    const authPath = join(root, "auth.json")
    symlinkSync(target, authPath)
    await expect(retireLegacyProviderConfig({ authPath, configPath })).rejects.toThrow("manual removal")

    rmSync(authPath)
    writeFileSync(authPath, JSON.stringify({ protocolVersion: 1, providers: {} }), { mode: 0o600 })
    chmodSync(authPath, 0o644)
    await expect(retireLegacyProviderConfig({ authPath, configPath })).rejects.toThrow("manual removal")

    chmodSync(authPath, 0o600)
    writeFileSync(authPath, JSON.stringify({ protocolVersion: 1, providers: { future: { type: "api", key: "secret" } } }), { mode: 0o600 })
    await expect(retireLegacyProviderConfig({ authPath, configPath })).rejects.toThrow("manual removal")
    expect(existsSync(authPath)).toBe(true)
  })
})
