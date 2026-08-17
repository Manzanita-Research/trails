import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isLegacyProviderHubConfig, loadHubConfig, writeHubConfig } from "../cli/config"

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trails-hub-config-"))
  path = join(dir, "server.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("hub config V3", () => {
  test("missing file loads as null", () => {
    expect(loadHubConfig(path)).toBeNull()
  })

  test("writes owner-only harness selection and off states", () => {
    writeHubConfig({ harness: "auto" }, path)
    expect(loadHubConfig(path)).toEqual({ summarizer: { harness: "auto" } })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    writeHubConfig({ harness: "codex" }, path)
    expect(loadHubConfig(path)).toEqual({ summarizer: { harness: "codex" } })

    writeHubConfig(null, path)
    expect(loadHubConfig(path)).toEqual({ summarizer: null })
  })

  test("rejects old provider configs instead of preserving compatibility", () => {
    writeFileSync(path, JSON.stringify({ protocolVersion: 2, summarizer: { provider: "openrouter" } }), { mode: 0o600 })
    expect(() => loadHubConfig(path)).toThrow("server configuration is invalid")

    writeHubConfig({ harness: "omp" }, path)
    expect(loadHubConfig(path)).toEqual({ summarizer: { harness: "omp" } })
    expect(existsSync(`${path}.v1.bak`)).toBe(false)
    expect(isLegacyProviderHubConfig(path)).toBe(false)
  })

  test("recognizes only exact owner-only provider-era V2 configs for retirement", () => {
    writeFileSync(path, JSON.stringify({
      protocolVersion: 2,
      summarizer: { provider: "chatgpt", model: "gpt-5.2-codex" },
    }), { mode: 0o600 })
    expect(isLegacyProviderHubConfig(path)).toBe(true)

    writeFileSync(path, JSON.stringify({
      protocolVersion: 2,
      summarizer: { provider: "future-provider" },
    }), { mode: 0o600 })
    expect(isLegacyProviderHubConfig(path)).toBe(false)
  })

  test("rejects invalid content, unsafe permissions, and unknown harnesses", () => {
    writeFileSync(path, JSON.stringify({ protocolVersion: 3, summarizer: { harness: "future" } }), { mode: 0o600 })
    expect(() => loadHubConfig(path)).toThrow("server configuration is invalid")

    writeFileSync(path, JSON.stringify({ protocolVersion: 3, summarizer: null }), { mode: 0o600 })
    chmodSync(path, 0o644)
    expect(() => loadHubConfig(path)).toThrow("server configuration is invalid")
    expect(() => writeHubConfig({ harness: "future" as never }, path)).toThrow()
  })
})
