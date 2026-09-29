import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { auditBinary } from "./binary-audit"
import { architectures, auditClient, auditPrivacy, auditVersion, digest, record, regularPath, requireAudit, type FileRecord } from "./release-audit"

const origin = "https://releases.manzanita.dev/"
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

async function auditInstaller(path: string) {
  await regularPath(path)
  const bytes = await readFile(path)
  auditPrivacy(bytes)
  requireAudit(!/__([A-Z][A-Z0-9_]*)__/.test(bytes.toString()), "unresolved installer placeholder")
  const child = Bun.spawn(["/bin/sh", "-n", path], { env: { PATH: "/usr/bin:/bin" }, stdout: "ignore", stderr: "ignore" })
  requireAudit(await child.exited === 0, "installer shell syntax is invalid")
}

async function policyHash() {
  const directory = fileURLToPath(new URL(".", import.meta.url))
  return digest(Buffer.concat(await Promise.all(["release-audit.ts", "binary-audit.ts", "stage-release.ts", "build-binaries.ts"].map((name) => readFile(join(directory, name))))))
}

// Recompute from the bytes that will be handed to the shared publisher.
export async function auditStaged(directory: string, assets: FileRecord[], version: string) {
  auditVersion(version)
  await regularPath(directory, true)
  const allowed = ["release-input.json", "install.sh", "SHA256SUMS", "release-audit.json", ...architectures.map((arch) => `trails-${arch}`)]
  for (const name of await readdir(directory)) requireAudit(allowed.includes(name), "unexpected staging file")
  const artifacts: Record<string, FileRecord & { path: string; contentType: string }> = {}
  const binaries = []
  for (const architecture of architectures) {
    const file = `trails-${architecture}`
    await regularPath(join(directory, file))
    const bytes = await readFile(join(directory, file))
    binaries.push(auditBinary(bytes, architecture, assets))
    artifacts[architecture] = { ...record(file, bytes), path: `trails/releases/${version}/${file}`, contentType: "application/octet-stream" }
  }
  const descriptor = { schemaVersion: 1, product: "trails", version, artifacts }
  await regularPath(join(directory, "release-input.json"))
  requireAudit(await readFile(join(directory, "release-input.json"), "utf8") === json(descriptor), "descriptor differs from validated files, paths, sizes or hashes")
  const checksums = Object.values(artifacts).map((a) => `${a.sha256}  ${a.file}\n`).join("")
  await regularPath(join(directory, "SHA256SUMS"))
  requireAudit(await readFile(join(directory, "SHA256SUMS"), "utf8") === checksums, "checksums differ from validated files")
  const installerPath = join(directory, "install.sh")
  await auditInstaller(installerPath)
  const installer = await readFile(installerPath, "utf8")
  for (const assignment of [
    `VERSION="${version}"`, `BASE_URL="${origin}trails/releases/${version}/"`,
    `ARM64_SHA256="${artifacts["darwin-arm64"].sha256}"`, `X64_SHA256="${artifacts["darwin-x64"].sha256}"`,
  ]) requireAudit(installer.split("\n").filter((line) => line === assignment).length === 1, "installer pins differ from descriptor")
  return {
    schemaVersion: 1, product: "trails", version, policySha256: await policyHash(),
    checks: ["macho-architecture", "bun-module-allowlist", "asset-hashes", "no-source-maps-or-bytecode", "privacy-patterns-and-sensitive-environment", "shell-syntax", "descriptor-and-checksums"],
    limitations: ["Pattern scanning cannot prove absence of arbitrary or encoded secrets.", "Upstream Bun CI paths are permitted outside the product module graph; operator paths are forbidden everywhere."],
    assets, binaries,
    files: await Promise.all(allowed.filter((name) => name !== "release-audit.json").sort().map(async (name) => record(name, await readFile(join(directory, name))))),
  }
}

export async function stageRelease(root = process.cwd()) {
  const packagePath = join(root, "package.json")
  await regularPath(packagePath)
  const { version } = JSON.parse(await readFile(packagePath, "utf8"))
  auditVersion(version) // Before constructing or removing any version-derived path.
  const assets = await auditClient(join(root, "dist/client"))
  const artifacts: Record<string, FileRecord & { path: string; contentType: string }> = {}
  for (const architecture of architectures) {
    const file = `trails-${architecture}`, path = join(root, "dist", file)
    await regularPath(path)
    const bytes = await readFile(path)
    auditBinary(bytes, architecture, assets)
    artifacts[architecture] = { ...record(file, bytes), path: `trails/releases/${version}/${file}`, contentType: "application/octet-stream" }
  }
  const templatePath = join(root, "scripts/install-release.sh")
  await regularPath(templatePath)
  const installer = (await readFile(templatePath, "utf8"))
    .replaceAll("__VERSION__", version)
    .replaceAll("__BASE_URL__", `${origin}trails/releases/${version}/`)
    .replaceAll("__ARM64_SHA256__", artifacts["darwin-arm64"].sha256)
    .replaceAll("__X64_SHA256__", artifacts["darwin-x64"].sha256)
  const parent = join(root, "dist/release/trails")
  // Validate existing ancestors before mkdir can follow a link.
  for (const path of [join(root, "dist"), join(root, "dist/release"), parent]) {
    try { await regularPath(path, true) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await mkdir(path)
    }
  }
  const temporary = await mkdtemp(join(parent, ".stage-"))
  try {
    for (const artifact of Object.values(artifacts)) {
      await copyFile(join(root, "dist", artifact.file), join(temporary, artifact.file))
      await chmod(join(temporary, artifact.file), 0o755)
    }
    await writeFile(join(temporary, "install.sh"), installer, { mode: 0o755 })
    await writeFile(join(temporary, "SHA256SUMS"), Object.values(artifacts).map((a) => `${a.sha256}  ${a.file}\n`).join(""))
    await writeFile(join(temporary, "release-input.json"), json({ schemaVersion: 1, product: "trails", version, artifacts }))
    const audit = await auditStaged(temporary, assets, version)
    await writeFile(join(temporary, "release-audit.json"), json(audit))
    const destination = join(parent, version)
    try { await regularPath(destination, true) } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    await rm(destination, { recursive: true, force: true })
    await rename(temporary, destination)
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  if (process.argv[2] === "--audit") {
    const directory = resolve(process.argv[3] ?? "")
    requireAudit(process.argv.length === 4, "usage: stage-release.ts --audit <staging-directory>")
    const { version } = JSON.parse(await readFile(join(directory, "release-input.json"), "utf8"))
    const report = await auditStaged(directory, await auditClient(resolve("dist/client")), version)
    await regularPath(join(directory, "release-audit.json"))
    requireAudit(await readFile(join(directory, "release-audit.json"), "utf8") === json(report), "audit report mismatch")
    console.log("release audit verified")
  } else {
    requireAudit(process.argv.length === 2, "unexpected staging arguments")
    console.log(`staged and audited at ${await stageRelease()}`)
  }
}
