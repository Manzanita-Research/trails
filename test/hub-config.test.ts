import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadHubConfig, writeHubConfig } from "../cli/config"

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trails-hub-config-"))
  path = join(dir, "server.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const V1 = JSON.stringify({
  protocolVersion: 1,
  aiUrl: "https://relay.example.com/api/summarize",
  aiToken: "legacy-token",
})

describe("hub config V2", () => {
  test("missing file loads as null", () => {
    expect(loadHubConfig(path)).toBeNull()
  })

  test("write/load roundtrip with and without model", () => {
    writeHubConfig({ provider: "chatgpt", model: "gpt-5.2-codex" }, path)
    expect(loadHubConfig(path)).toEqual({
      summarizer: { provider: "chatgpt", model: "gpt-5.2-codex" },
      legacyRelay: false,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)

    writeHubConfig({ provider: "openrouter" }, path)
    expect(loadHubConfig(path)?.summarizer).toEqual({ provider: "openrouter" })

    writeHubConfig(null, path)
    expect(loadHubConfig(path)).toEqual({ summarizer: null, legacyRelay: false })
  })

  test("legacy V1 relay config reads as disconnected", () => {
    writeFileSync(path, V1, { mode: 0o600 })
    expect(loadHubConfig(path)).toEqual({ summarizer: null, legacyRelay: true })
  })

  test("first V2 write over V1 preserves a .v1.bak", () => {
    writeFileSync(path, V1, { mode: 0o600 })
    writeHubConfig({ provider: "openrouter", model: "openrouter/auto" }, path)

    const backup = `${path}.v1.bak`
    expect(readFileSync(backup, "utf8")).toBe(V1)
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(loadHubConfig(path)).toEqual({
      summarizer: { provider: "openrouter", model: "openrouter/auto" },
      legacyRelay: false,
    })
  })

  test("corrupt existing file is replaced without a backup", () => {
    writeFileSync(path, "not json", { mode: 0o600 })
    writeHubConfig({ provider: "openai-api" }, path)
    expect(existsSync(`${path}.v1.bak`)).toBe(false)
    expect(loadHubConfig(path)?.summarizer).toEqual({ provider: "openai-api" })
  })

  test("invalid content and unsafe permissions are rejected on load", () => {
    writeFileSync(path, JSON.stringify({ protocolVersion: 3 }), { mode: 0o600 })
    expect(() => loadHubConfig(path)).toThrow("server configuration is invalid")

    writeFileSync(path, JSON.stringify({ protocolVersion: 2, summarizer: null }), { mode: 0o600 })
    chmodSync(path, 0o644)
    expect(() => loadHubConfig(path)).toThrow("server configuration is invalid")
  })

  test("rejects unknown provider and empty model on write", () => {
    expect(() => writeHubConfig({ provider: "anthropic" as never }, path)).toThrow()
    expect(() => writeHubConfig({ provider: "chatgpt", model: "" }, path)).toThrow()
  })
})
