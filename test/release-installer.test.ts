import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const roots = new Set<string>()
interface InstallerFixture {
  readonly root: string
  readonly installer: string
  readonly artifacts: {
    readonly arm64: string
    readonly x86_64: string
  }
}


afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

async function fixture(baseUrl = "https://releases.example/trails/releases/0.1.0-alpha-test/"): Promise<InstallerFixture> {
  const root = await mkdtemp(join(tmpdir(), "trails-release-installer-test-"))
  roots.add(root)
  const bin = join(root, "fake-bin")
  await mkdir(bin)
  await writeFile(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo "$TRAILS_TEST_ARCH" ;; *) exit 1 ;; esac\n',
  )
  await writeFile(
    join(bin, "curl"),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$HOME/curl-args"\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    https://*) url=$1 ;;\n    --output) output=$2; shift ;;\n  esac\n  shift\ndone\nprintf "%s\\n" "$url" > "$HOME/download-url"\ncp "$TRAILS_TEST_ARTIFACT" "$output"\n',
  )
  await chmod(join(bin, "uname"), 0o755)
  await chmod(join(bin, "curl"), 0o755)

  const artifacts = {
    arm64: join(root, "trails-darwin-arm64"),
    x86_64: join(root, "trails-darwin-x64"),
  }
  await writeFile(artifacts.arm64, '#!/bin/sh\nprintf "%s\\n" "arm64:$*" > "$HOME/setup-args"\n', { mode: 0o755 })
  await writeFile(artifacts.x86_64, '#!/bin/sh\nprintf "%s\\n" "x64:$*" > "$HOME/setup-args"\n', { mode: 0o755 })
  const template = await readFile(resolve("scripts/install-release.sh"), "utf8")
  const installer = join(root, "install.sh")
  await writeFile(
    installer,
    template
      .replaceAll("__VERSION__", "0.1.0-alpha-test")
      .replaceAll("__BASE_URL__", baseUrl)
      .replaceAll("__ARM64_SHA256__", await sha256(artifacts.arm64))
      .replaceAll("__X64_SHA256__", await sha256(artifacts.x86_64)),
    { mode: 0o755 },
  )
  return { root, installer, artifacts }
}

function runInstaller(
  fixture: InstallerFixture,
  architecture: string,
  args: readonly string[],
  artifact?: string,
) {
  const selectedArtifact = artifact ?? (architecture === "x86_64" ? fixture.artifacts.x86_64 : fixture.artifacts.arm64)
  return Bun.spawn(["/bin/sh", fixture.installer, ...args], {
    env: {
      HOME: fixture.root,
      PATH: `${join(fixture.root, "fake-bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TRAILS_TEST_ARCH: architecture,
      TRAILS_TEST_ARTIFACT: selectedArtifact,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("stable release installer", () => {
  test("selects each macOS architecture, verifies, and atomically installs", async () => {
    for (const [architecture, file, prefix] of [
      ["arm64", "trails-darwin-arm64", "arm64"],
      ["x86_64", "trails-darwin-x64", "x64"],
    ] as const) {
      const current = await fixture()
      const process = runInstaller(current, architecture, ["join", "https://hub.example.ts.net/", "--name", "Laptop"])
      expect(await process.exited).toBe(0)
      expect(await readFile(join(current.root, "download-url"), "utf8")).toEndWith(`/${file}\n`)
      expect(await readFile(join(current.root, "setup-args"), "utf8")).toBe(
        `${prefix}:setup join https://hub.example.ts.net/ --name Laptop\n`,
      )
      const installed = join(current.root, ".local/bin/trails")
      expect((await stat(installed)).mode & 0o111).not.toBe(0)
      expect(await readFile(installed, "utf8")).toBe(await readFile(current.artifacts[architecture], "utf8"))
    }
  })

  test("forwards all hub setup arguments unchanged", async () => {
    const current = await fixture()
    const process = runInstaller(current, "arm64", ["hub", "--service", "svc:trails", "--name", "Home Mac"])
    expect(await process.exited).toBe(0)
    expect(await readFile(join(current.root, "setup-args"), "utf8")).toBe(
      "arm64:setup hub --service svc:trails --name Home Mac\n",
    )
  })

  test("rejects unsupported architectures before download", async () => {
    const current = await fixture()
    const process = runInstaller(current, "powerpc", ["hub"])
    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain("unsupported Mac architecture")
    expect(Bun.file(join(current.root, "download-url")).size).toBe(0)
  })

  test("requires an HTTPS immutable release URL", async () => {
    const current = await fixture("http://releases.example/trails/releases/0.1.0-alpha-test/")
    const process = runInstaller(current, "arm64", ["hub"])
    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain("must use HTTPS")
    expect(Bun.file(join(current.root, "download-url")).size).toBe(0)
  })

  test("checksum failure preserves an existing install and skips setup", async () => {
    const current = await fixture()
    const installed = join(current.root, ".local/bin/trails")
    await mkdir(join(current.root, ".local/bin"), { recursive: true })
    await writeFile(installed, "existing binary", { mode: 0o700 })
    await writeFile(current.artifacts.arm64, "corrupt")
    const process = runInstaller(current, "arm64", ["hub"])

    expect(await process.exited).not.toBe(0)
    expect(await new Response(process.stderr).text()).toContain("checksum did not match")
    expect(await readFile(installed, "utf8")).toBe("existing binary")
    expect(Bun.file(join(current.root, "setup-args")).size).toBe(0)
    const staged = join(current.root, ".local/bin", `.trails.${process.pid}`)
    expect(Bun.file(staged).size).toBe(0)
  })
})
