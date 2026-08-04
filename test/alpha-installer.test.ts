import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture(): Promise<{ readonly root: string; readonly installer: string }> {
  const root = await mkdtemp(join(tmpdir(), "trails-alpha-installer-test-"))
  roots.add(root)
  const bin = join(root, "fake-bin")
  await mkdir(bin)
  await writeFile(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo arm64 ;; *) exit 1 ;; esac\n',
  )
  await writeFile(
    join(bin, "curl"),
    '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then cp "$TRAILS_TEST_ARTIFACT" "$2"; exit 0; fi\n  shift\ndone\nexit 1\n',
  )
  await chmod(join(bin, "uname"), 0o755)
  await chmod(join(bin, "curl"), 0o755)

  const artifact = join(root, "trails-darwin-arm64")
  await writeFile(artifact, '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/setup-args"\n', { mode: 0o755 })
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(artifact).arrayBuffer())
  const sha = hasher.digest("hex")
  const template = await readFile(resolve("scripts/install-alpha.sh"), "utf8")
  const installer = join(root, "install.sh")
  await writeFile(
    installer,
    template
      .replaceAll("__VERSION__", "0.1.0-alpha-test")
      .replaceAll("__BASE_URL__", "https://alpha.example/")
      .replaceAll("__ARM64_SHA256__", sha)
      .replaceAll("__X64_SHA256__", "unused"),
    { mode: 0o755 },
  )
  return { root, installer }
}

describe("temporary alpha installer", () => {
  test("verifies, atomically installs, and hands off to one-command setup", async () => {
    const { root, installer } = await fixture()
    const artifact = join(root, "trails-darwin-arm64")
    const process = Bun.spawn(
      ["/bin/sh", installer, "join", "https://hub.example.ts.net/", "--name", "Laptop"],
      {
        env: {
          HOME: root,
          PATH: `${join(root, "fake-bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
          TRAILS_TEST_ARTIFACT: artifact,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )

    expect(await process.exited).toBe(0)
    expect(await readFile(join(root, "setup-args"), "utf8")).toBe(
      "setup join https://hub.example.ts.net/ --name Laptop\n",
    )
    const installed = join(root, ".local/bin/trails")
    expect((await stat(installed)).mode & 0o111).not.toBe(0)
    expect(await readFile(installed, "utf8")).toBe(await readFile(artifact, "utf8"))
  })

  test("rejects a corrupt download before installation or setup", async () => {
    const { root, installer } = await fixture()
    const artifact = join(root, "trails-darwin-arm64")
    await writeFile(artifact, "corrupt")
    const process = Bun.spawn(["/bin/sh", installer, "hub"], {
      env: {
        HOME: root,
        PATH: `${join(root, "fake-bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
        TRAILS_TEST_ARTIFACT: artifact,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain("checksum did not match")
    expect(Bun.file(join(root, ".local/bin/trails")).size).toBe(0)
    expect(Bun.file(join(root, "setup-args")).size).toBe(0)
  })
})
