import packageJson from "../package.json" with { type: "json" }
import { chmod, copyFile, mkdir, readFile, rm, stat } from "node:fs/promises"
import { resolve } from "node:path"

const product = "trails"
const version = packageJson.version
const origin = new URL("https://releases.manzanita.dev/")
const versionPrefix = `${product}/releases/${version}/`
const outputDirectory = resolve("dist", "release", product, version)
const sources = {
  "darwin-arm64": resolve("dist/trails-darwin-arm64"),
  "darwin-x64": resolve("dist/trails-darwin-x64"),
} as const

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest("hex")
}

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const artifacts: Record<string, {
  readonly file: string
  readonly path: string
  readonly sha256: string
  readonly size: number
  readonly contentType: string
}> = {}
for (const [name, source] of Object.entries(sources)) {
  const file = `trails-${name}`
  const destination = resolve(outputDirectory, file)
  const sourceInfo = await stat(source)
  if (!sourceInfo.isFile() || sourceInfo.size === 0) throw new Error(`${source} is not a built release binary`)
  await copyFile(source, destination)
  await chmod(destination, 0o755)
  artifacts[name] = {
    file,
    path: `${versionPrefix}${file}`,
    sha256: await sha256(destination),
    size: sourceInfo.size,
    contentType: "application/octet-stream",
  }
}

const template = await readFile(resolve("scripts/install-release.sh"), "utf8")
const installer = template
  .replaceAll("__VERSION__", version)
  .replaceAll("__BASE_URL__", new URL(versionPrefix, origin).href)
  .replaceAll("__ARM64_SHA256__", artifacts["darwin-arm64"]!.sha256)
  .replaceAll("__X64_SHA256__", artifacts["darwin-x64"]!.sha256)
if (installer.includes("__VERSION__") || installer.includes("__BASE_URL__") || installer.includes("__ARM64_SHA256__") || installer.includes("__X64_SHA256__")) {
  throw new Error("release installer contains an unresolved placeholder")
}
const installerPath = resolve(outputDirectory, "install.sh")
await Bun.write(installerPath, installer)
await chmod(installerPath, 0o755)

const checksums = Object.values(artifacts)
  .sort((left, right) => left.file.localeCompare(right.file))
  .map((artifact) => `${artifact.sha256}  ${artifact.file}\n`)
  .join("")
await Bun.write(resolve(outputDirectory, "SHA256SUMS"), checksums)
await Bun.write(resolve(outputDirectory, "release-input.json"), `${JSON.stringify({
  schemaVersion: 1,
  product,
  version,
  artifacts,
}, null, 2)}\n`)

console.log(`staged ${product} ${version} at ${outputDirectory}`)
for (const [name, artifact] of Object.entries(artifacts)) {
  console.log(`${name} ${artifact.size} ${artifact.sha256} ${resolve(outputDirectory, artifact.file)}`)
}
console.log(`installer ${Bun.file(installerPath).size} ${await sha256(installerPath)} ${installerPath}`)
