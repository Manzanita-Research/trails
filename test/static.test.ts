import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { File } from "node:buffer"
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"

const shell = "<!doctype html><title>Trails shell</title>"
const privateBytes = "SYNTHETIC_OUTSIDE_STATIC"
let root: string
let staticRoot: string
let db: TrailsDb
let app: ReturnType<typeof createApp>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "trails-static-test-"))
  staticRoot = join(root, "static")
  await mkdir(join(staticRoot, "assets"), { recursive: true })
  await writeFile(join(staticRoot, "index.html"), shell)
  await writeFile(join(staticRoot, "assets", "app-12345678.js"), "console.log('asset')")
  await writeFile(join(staticRoot, "space name.txt"), "normal file")
  await writeFile(join(root, "private.txt"), privateBytes)
  db = openDatabase(":memory:")
  app = createApp({ db, trustedOrigins: ["http://trails.test"], staticRoot })
})

afterEach(async () => {
  db?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

function request(path: string, method = "GET") {
  return app(new Request(`http://trails.test${path}`, { method }))
}

async function rejected(path: string, status = 404) {
  for (const method of ["GET", "HEAD"]) {
    const response = await request(path, method)
    expect(response.status).toBe(status)
    expect(await response.text()).not.toContain(privateBytes)
  }
}

describe("source static confinement", () => {
  test("rejects direct, dangling, and in-root file symlinks", async () => {
    await symlink(join(root, "private.txt"), join(staticRoot, "link.txt"))
    await symlink(join(root, "missing.txt"), join(staticRoot, "dangling.txt"))
    await symlink("index.html", join(staticRoot, "internal.html"))
    for (const path of ["/link.txt", "/%6cink.txt", "/dangling.txt", "/internal.html"]) await rejected(path)
  })

  test("rejects symlinked parent directories, including missing children", async () => {
    await symlink(root, join(staticRoot, "outside"))
    await symlink("assets", join(staticRoot, "internal"))
    for (const path of ["/outside/private.txt", "/outside%2fprivate.txt", "/outside/missing", "/internal/app-12345678.js"]) {
      await rejected(path)
    }
  })

  test("rejects a symlinked SPA index for root, direct, and fallback requests", async () => {
    await rm(join(staticRoot, "index.html"))
    await symlink(join(root, "private.txt"), join(staticRoot, "index.html"))
    for (const path of ["/", "/index.html", "/days/2026-09-16"]) await rejected(path)
  })

  test("rejects directories and FIFOs without reading or blocking", async () => {
    for (const path of ["/assets", "/assets/", "/assets/./"]) await rejected(path)
    const fifo = join(staticRoot, "pipe.txt")
    const result = Bun.spawnSync(["mkfifo", fifo])
    expect(result.exitCode).toBe(0)
    await rejected("/pipe.txt")
    await rm(join(staticRoot, "index.html"))
    await mkdir(join(staticRoot, "index.html"))
    await rejected("/missing")
  })

  test("rejects encoded traversal, malformed escapes, and null bytes", async () => {
    for (const path of ["/%2e%2e%2fprivate.txt", "/assets/..%2F..%2fprivate.txt", "/%2F..%2Fprivate.txt", "/bad%00.txt", "/bad%", "/%ff"]) {
      await rejected(path, 400)
    }
    const doubleEncoded = await request("/%252e%252e%252fprivate.txt")
    expect(doubleEncoded.status).toBe(200)
    expect(await doubleEncoded.text()).toBe(shell)
  })

  test("serves normal files, HEAD metadata, and SPA fallbacks", async () => {
    const asset = await request("/assets/app-12345678.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("content-type")).toContain("javascript")
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await asset.text()).toBe("console.log('asset')")
    const normal = await request("/space%20name.txt")
    expect(normal.status).toBe(200)
    expect(await normal.text()).toBe("normal file")
    const head = await request("/space%20name.txt", "HEAD")
    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe("11")
    expect(head.headers.get("cache-control")).toBe("no-cache")
    expect(await head.text()).toBe("")
    for (const path of ["/", "/index.html", "/days/2026-09-16"]) {
      const response = await request(path)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.text()).toBe(shell)
    }
    await rm(join(staticRoot, "index.html"))
    await rejected("/missing")
  })

  test("resolves the configured root through host directory aliases", async () => {
    const alias = join(root, "static-alias")
    await symlink(staticRoot, alias)
    app = createApp({ db, trustedOrigins: ["http://trails.test"], staticRoot: alias })
    expect(await (await request("/space%20name.txt")).text()).toBe("normal file")
  })

  test("does not reopen a path after returning the response", async () => {
    const response = await request("/space%20name.txt")
    await rename(join(staticRoot, "space name.txt"), join(staticRoot, "original.txt"))
    await symlink(join(root, "private.txt"), join(staticRoot, "space name.txt"))
    expect(await response.text()).toBe("normal file")
    await rejected("/space%20name.txt")
  })
})

test("serves embedded assets and SPA fallbacks without disk files", async () => {
  const staticAssets = [
    new File([shell], "index.html", { type: "text/html" }),
    new File(["embedded"], "app-12345678.js", { type: "text/javascript" }),
  ]
  app = createApp({ db, trustedOrigins: ["http://trails.test"], staticRoot: "/$bunfs/root/dist/client", staticAssets })
  const asset = await request("/assets/app-12345678.js")
  expect(asset.status).toBe(200)
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await asset.text()).toBe("embedded")
  for (const path of ["/", "/days/2026-09-16"]) {
    const response = await request(path)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.text()).toBe(shell)
  }
  const head = await request("/assets/app-12345678.js", "HEAD")
  expect(head.headers.get("content-length")).toBe("8")
  expect(await head.text()).toBe("")
  await rejected("/%2e%2e%2fprivate.txt", 400)
})
