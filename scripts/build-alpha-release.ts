import packageJson from "../package.json" with { type: "json" }
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

const rawBaseUrl = process.argv[2]
if (!rawBaseUrl) throw new Error("usage: bun scripts/build-alpha-release.ts https://release.example/")
const baseUrl = new URL(rawBaseUrl)
if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error("alpha release URL must be a credential-free HTTPS URL")
}
baseUrl.pathname = `${baseUrl.pathname.replace(/\/*$/, "")}/`

const outputDirectory = resolve("dist/alpha")
const artifacts = {
  arm64: resolve("dist/trails-darwin-arm64"),
  x64: resolve("dist/trails-darwin-x64"),
} as const

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

const [arm64Sha, x64Sha, template] = await Promise.all([
  sha256(artifacts.arm64),
  sha256(artifacts.x64),
  readFile(resolve("scripts/install-alpha.sh"), "utf8"),
])
const installer = template
  .replaceAll("__VERSION__", packageJson.version)
  .replaceAll("__BASE_URL__", baseUrl.toString())
  .replaceAll("__ARM64_SHA256__", arm64Sha)
  .replaceAll("__X64_SHA256__", x64Sha)

if (installer.includes("__")) throw new Error("alpha installer contains an unresolved placeholder")
await mkdir(outputDirectory, { recursive: true })
await Promise.all([
  Bun.write(resolve(outputDirectory, "install.sh"), installer),
  copyFile(artifacts.arm64, resolve(outputDirectory, "trails-darwin-arm64")),
  copyFile(artifacts.x64, resolve(outputDirectory, "trails-darwin-x64")),
])
await Promise.all([
  chmod(resolve(outputDirectory, "install.sh"), 0o755),
  chmod(resolve(outputDirectory, "trails-darwin-arm64"), 0o755),
  chmod(resolve(outputDirectory, "trails-darwin-x64"), 0o755),
])

console.log(`wrote ${outputDirectory}`)
console.log(`version ${packageJson.version}`)
console.log(`base ${baseUrl}`)
console.log(`arm64 ${arm64Sha}`)
console.log(`x64 ${x64Sha}`)
