import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { auditBinary } from "../scripts/binary-audit"
import { architectures, auditClient, auditPrivacy, fonts, type Architecture, type FileRecord } from "../scripts/release-audit"
import { auditStaged, stageRelease } from "../scripts/stage-release"

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

// Tiny structural fixtures; real production binaries are validated by release:stage.
function binary(architecture: Architecture, files: { name: string; content: Buffer }[]) {
  const parts: Buffer[] = [], modules: Buffer[] = []
  let length = 0
  for (const [index, file] of files.entries()) {
    const module = Buffer.alloc(52)
    for (const [pointer, bytes] of [[0, Buffer.from(file.name)], [8, file.content]] as const) {
      module.writeUInt32LE(length, pointer)
      module.writeUInt32LE(bytes.length, pointer + 4)
      parts.push(bytes, Buffer.alloc(1)); length += bytes.length + 1
    }
    module.set(index === 0 ? [1, 1, 1, 0] : [0, 5, 0, 1], 48)
    modules.push(module)
  }
  const table = Buffer.concat(modules), offsets = Buffer.alloc(32)
  offsets.writeBigUInt64LE(BigInt(length + table.length + 1))
  offsets.writeUInt32LE(length, 8); offsets.writeUInt32LE(table.length, 12)
  offsets.writeUInt32LE(length + table.length, 20); offsets.writeUInt32LE(15, 28)
  const graph = Buffer.concat([...parts, table, Buffer.alloc(1), offsets, Buffer.from("\n---- Bun! ----\n")])
  const header = Buffer.alloc(216)
  header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(architecture === "darwin-arm64" ? 0x100000c : 0x1000007, 4)
  header.writeUInt32LE(2, 12); header.writeUInt32LE(2, 16); header.writeUInt32LE(176, 20)
  header.writeUInt32LE(0x19, 32); header.writeUInt32LE(152, 36); header.write("__BUN", 40)
  header.writeBigUInt64LE(208n, 72); header.writeBigUInt64LE(BigInt(graph.length + 8), 80); header.writeUInt32LE(1, 96)
  header.write("__bun", 104); header.write("__BUN", 120)
  header.writeBigUInt64LE(BigInt(graph.length + 8), 144); header.writeUInt32LE(208, 152)
  header.writeUInt32LE(0x80000028, 184); header.writeUInt32LE(24, 188)
  header.writeBigUInt64LE(BigInt(graph.length), 208)
  return Buffer.concat([header, graph])
}

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "trails-audit-")); roots.push(root)
  await mkdir(join(root, "scripts")); await mkdir(join(root, "dist/client/assets"), { recursive: true }); await mkdir(join(root, "dist/client/fonts"))
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "0.1.0-audit-test" }))
  await writeFile(join(root, "scripts/install-release.sh"), await readFile("scripts/install-release.sh"))
  for (const file of [...fonts, "index.html", "assets/index-12345678.js", "assets/index-12345678.css"]) {
    await writeFile(join(root, "dist/client", file), file.endsWith("woff2") ? "wOF2fixture" : "public product content")
  }
  const assets = await auditClient(join(root, "dist/client"))
  const files = [{ name: "/$bunfs/root/compiled-entry.js", content: Buffer.from("console.log('product')") }]
  for (const asset of assets) files.push({ name: `/$bunfs/root/${asset.file.split("/").at(-1)}`, content: await readFile(join(root, "dist/client", asset.file)) })
  for (const arch of architectures) await writeFile(join(root, "dist", `trails-${arch}`), binary(arch, files))
  return { root, assets, files }
}

function inspect(bytes: Buffer, assets: FileRecord[], arch: Architecture = "darwin-arm64") { return auditBinary(bytes, arch, assets) }

test("stages both architectures with a reproducible audit artifact", async () => {
  const { root, assets } = await fixture()
  const directory = await stageRelease(root)
  const first = await readFile(join(directory, "release-audit.json"), "utf8")
  expect(JSON.parse(first)).toEqual(await auditStaged(directory, assets, "0.1.0-audit-test"))
  expect(JSON.parse(first).binaries.map((b: { architecture: string }) => b.architecture)).toEqual([...architectures])
  expect(first).not.toContain(root)
  await stageRelease(root)
  expect(await readFile(join(directory, "release-audit.json"), "utf8")).toBe(first)
})

for (const arch of architectures) {
  for (const corruption of ["text", "architecture", "dylib", "truncated", "source-map", "bytecode", "unknown-file", "changed-asset", "private-payload", "autoload", "overlap"] as const) {
    test(`${arch} rejects ${corruption}`, async () => {
      const { root, assets, files } = await fixture()
      let bytes = binary(arch, files)
      if (corruption === "text") bytes = Buffer.from("SYNTHETIC_PRIVATE_PAYLOAD_NOT_A_MACHO_BINARY")
      if (corruption === "architecture") bytes.writeUInt32LE(arch === "darwin-arm64" ? 0x1000007 : 0x100000c, 4)
      if (corruption === "dylib") bytes.writeUInt32LE(6, 12)
      if (corruption === "truncated") bytes = bytes.subarray(0, 220)
      if (corruption === "unknown-file") bytes = binary(arch, [...files, { name: "/$bunfs/root/private.json", content: Buffer.from("private") }])
      if (corruption === "changed-asset") { files[1].content = Buffer.from("different"); bytes = binary(arch, files) }
      if (corruption === "private-payload") { files[0].content = Buffer.from("SYNTHETIC_PRIVATE_PAYLOAD"); bytes = binary(arch, files) }
      if (["source-map", "bytecode", "autoload", "overlap"].includes(corruption)) {
        const offsets = bytes.length - 48
        const table = 216 + bytes.readUInt32LE(offsets + 8)
        if (corruption === "source-map") bytes.writeUInt32LE(1, table + 20)
        if (corruption === "bytecode") bytes.writeUInt32LE(1, table + 28)
        if (corruption === "autoload") bytes.writeUInt32LE(0, offsets + 28)
        if (corruption === "overlap") bytes.writeUInt32LE(0, table + 8)
      }
      expect(() => inspect(bytes, assets, arch)).toThrow("release audit")
      await writeFile(join(root, "dist", `trails-${arch}`), bytes)
      await expect(stageRelease(root)).rejects.toThrow("release audit")
    })
  }
}

for (const path of ["assets/index-12345678.js.map", "secrets.json", ".env", "transcript.jsonl", ".git/HEAD", "assets/index-87654321.js"]) {
  test(`rejects unexpected asset ${path}`, async () => {
    const { root } = await fixture()
    const destination = join(root, "dist/client", path)
    await mkdir(join(destination, ".."), { recursive: true }); await writeFile(destination, "unexpected")
    await expect(stageRelease(root)).rejects.toThrow("release audit")
  })
}
for (const target of ["dist/client/index.html", "dist/client/fonts", "dist/client", "dist/trails-darwin-arm64", "scripts/install-release.sh"]) {
  test(`rejects symlink ${target}`, async () => {
    const { root } = await fixture()
    const path = join(root, target), saved = join(root, "saved")
    const { rename } = await import("node:fs/promises")
    await rename(path, saved); await symlink(saved, path)
    await expect(stageRelease(root)).rejects.toThrow("symlinks")
  })
}

test("rejects FIFO assets without opening them", async () => {
  const { root } = await fixture()
  const child = Bun.spawn(["mkfifo", join(root, "dist/client/fifo")])
  expect(await child.exited).toBe(0)
  await expect(stageRelease(root)).rejects.toThrow("regular file")
})

for (const value of ["SYNTHETIC_PRIVATE_PAYLOAD", "TRAILS_PRIVATE_TRANSCRIPT", "TRAILS_PRIVATE_DIGEST", "/Users/private-person/work", "/home/private-person/work", "https://private.example.ts.net/", "https://192.168.1.2/", "-----BEGIN PRIVATE KEY-----", "ghp_" + "a".repeat(36), "sk-proj-" + "a".repeat(30), 'password="' + "a".repeat(32) + '"', "//# sourceMappingURL=data:application/json;base64,e30=", '"sourcesContent":["source"]', "commit " + "a".repeat(40) + "\n", '{"type":"session_meta", "text":"private"}']) {
  test(`privacy fixture ${value.slice(0, 24)}`, () => { expect(() => auditPrivacy(Buffer.from(value))).toThrow("release audit") })
}

test("sensitive environment values are rejected without disclosure", () => {
  process.env.TRAILS_AUDIT_TEST_SECRET = "environment-private-canary-12345"
  try { expect(() => auditPrivacy(Buffer.from(process.env.TRAILS_AUDIT_TEST_SECRET!))).toThrow("embedded sensitive environment value (withheld)") }
  finally { delete process.env.TRAILS_AUDIT_TEST_SECRET }
})

for (const installer of ["if then", "#!/bin/sh\necho __UNKNOWN_PLACEHOLDER__\n", "#!/bin/sh\necho SYNTHETIC_PRIVATE_PAYLOAD\n"]) {
  test("rejects invalid/private installer", async () => {
    const { root } = await fixture()
    await writeFile(join(root, "scripts/install-release.sh"), installer)
    await expect(stageRelease(root)).rejects.toThrow("release audit")
    expect(await Bun.file(join(root, "dist/release/trails/0.1.0-audit-test/release-input.json")).exists()).toBe(false)
  })
}
for (const version of ["../../escape", "x\"; touch bad", "", "0.1.0-a..b"]) {
  test(`rejects unsafe version ${version}`, async () => {
    const { root } = await fixture()
    await writeFile(join(root, "package.json"), JSON.stringify({ version }))
    await expect(stageRelease(root)).rejects.toThrow("unsafe release version")
  })
}
for (const mutation of ["size", "hash", "path", "product", "schema", "extra", "checksums", "installer-pins", "extra-file"] as const) {
  test(`independent audit rejects ${mutation} tampering`, async () => {
    const { root, assets } = await fixture(), directory = await stageRelease(root)
    const descriptorPath = join(directory, "release-input.json")
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"))
    const artifact = descriptor.artifacts["darwin-arm64"]
    if (mutation === "size") artifact.size++
    if (mutation === "hash") artifact.sha256 = "0".repeat(64)
    if (mutation === "path") artifact.path = "../escape"
    if (mutation === "product") descriptor.product = "other"
    if (mutation === "schema") descriptor.schemaVersion = 2
    if (mutation === "extra") descriptor.secret = "unexpected"
    await writeFile(descriptorPath, JSON.stringify(descriptor, null, 2) + "\n")
    if (mutation === "checksums") await writeFile(join(directory, "SHA256SUMS"), "bad")
    if (mutation === "installer-pins") await writeFile(join(directory, "install.sh"), "#!/bin/sh\nexit 0\n")
    if (mutation === "extra-file") await writeFile(join(directory, ".env"), "unexpected")
    await expect(auditStaged(directory, assets, "0.1.0-audit-test")).rejects.toThrow("release audit")
  })
}

for (const value of ["/Users/private-person/native/path", "https://private.example.ts.net/", "SYNTHETIC_PRIVATE_PAYLOAD"]) {
  test("rejects private content outside the Bun section", async () => {
    const { assets, files } = await fixture()
    expect(() => inspect(Buffer.concat([binary("darwin-arm64", files), Buffer.from(value)]), assets)).toThrow("release audit")
  })
}

test("private text in an allowed client filename fails before compilation", async () => {
  const { root } = await fixture()
  await writeFile(join(root, "dist/client/assets/index-12345678.js"), "SYNTHETIC_PRIVATE_PAYLOAD")
  await expect(stageRelease(root)).rejects.toThrow("forbidden private fixture")
  const child = Bun.spawn([process.execPath, join(process.cwd(), "scripts/build-binaries.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" })
  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stderr).text()).toContain("forbidden private fixture")
})

test("known upstream native paths remain forbidden in product payloads", () => {
  const path = "/Users/runner/work/_temp/webkit-release/JavaScriptCore/DerivedSources/AirOpcodeGenerated.h"
  expect(() => auditPrivacy(Buffer.from(path), false)).not.toThrow()
  expect(() => auditPrivacy(Buffer.from(path))).toThrow("personal path")
})
