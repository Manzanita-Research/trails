import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getCredential,
  loadCredentials,
  modifyCredentials,
  removeCredential,
  setCredential,
  type Credential,
} from "../cli/auth"

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trails-auth-"))
  path = join(dir, "nested", "auth.json")
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const oauth: Credential = {
  type: "oauth",
  access: "access-token",
  refresh: "refresh-token",
  expires: 1_900_000_000_000,
  accountId: "acct-1",
}

describe("credential store", () => {
  test("set/get/remove roundtrip with owner-only permissions", () => {
    setCredential("chatgpt", oauth, path)
    setCredential("openrouter", { type: "api", key: "sk-or-abc" }, path)

    expect(getCredential("chatgpt", path)).toEqual(oauth)
    expect(getCredential("openrouter", path)).toEqual({ type: "api", key: "sk-or-abc" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700)

    expect(removeCredential("chatgpt", path)).toBe(true)
    expect(removeCredential("chatgpt", path)).toBe(false)
    expect(getCredential("chatgpt", path)).toBeNull()
    expect(getCredential("openrouter", path)).not.toBeNull()
  })

  test("missing file reads as empty store", () => {
    expect(loadCredentials(path)).toEqual({})
  })

  test("unknown provider entries survive modification", () => {
    setCredential("chatgpt", oauth, path)
    modifyCredentials((providers) => {
      providers["future-provider"] = { type: "api", key: "keep-me" }
    }, path)
    setCredential("openai-api", { type: "api", key: "sk-x" }, path)

    const providers = loadCredentials(path)
    expect(providers["future-provider"]).toEqual({ type: "api", key: "keep-me" })
    expect(Object.keys(providers).sort()).toEqual(["chatgpt", "future-provider", "openai-api"])
  })

  test("group-readable store is rejected", () => {
    setCredential("chatgpt", oauth, path)
    chmodSync(path, 0o640)
    expect(() => loadCredentials(path)).toThrow("credential store is invalid")
  })

  test("malformed and schema-invalid content is rejected", () => {
    setCredential("chatgpt", oauth, path)
    writeFileSync(path, "not json", { mode: 0o600 })
    expect(() => loadCredentials(path)).toThrow("credential store is invalid")

    writeFileSync(
      path,
      JSON.stringify({ protocolVersion: 1, providers: { chatgpt: { type: "oauth", access: "a" } } }),
      { mode: 0o600 },
    )
    expect(() => loadCredentials(path)).toThrow("credential store is invalid")

    writeFileSync(
      path,
      JSON.stringify({ protocolVersion: 1, providers: {}, extra: true }),
      { mode: 0o600 },
    )
    expect(() => loadCredentials(path)).toThrow("credential store is invalid")
  })

  test("stale lock is broken", () => {
    setCredential("chatgpt", oauth, path)
    const lockPath = `${path}.lock`
    writeFileSync(lockPath, "12345\n", { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    setCredential("openai-api", { type: "api", key: "sk-x" }, path)
    expect(getCredential("openai-api", path)).toEqual({ type: "api", key: "sk-x" })
  })

  test("fresh lock blocks concurrent modification", () => {
    setCredential("chatgpt", oauth, path)
    writeFileSync(`${path}.lock`, "12345\n", { mode: 0o600 })

    expect(() =>
      modifyCredentials(
        (providers) => {
          providers["openai-api"] = { type: "api", key: "sk-x" }
        },
        path,
        { retries: 3, retryMs: 5 },
      ),
    ).toThrow("credential store is locked")
    expect(getCredential("chatgpt", path)).toEqual(oauth)
  })
})
