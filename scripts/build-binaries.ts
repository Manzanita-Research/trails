import { auditClient, regularPath } from "./release-audit"
import { auditBinary } from "./binary-audit"
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const minimum = [1, 3, 14]
const current = Bun.version.split(".").map(Number)
for (let index = 0; index < minimum.length; index++) {
  if ((current[index] ?? 0) > minimum[index]) break
  if ((current[index] ?? 0) < minimum[index]) throw new Error("Bun 1.3.14 or newer is required")
}

await mkdir(resolve("dist"), { recursive: true })

const clientRoot = resolve("dist/client")
const compiledEntry = resolve("dist/compiled-entry.ts")
const assets = await auditClient(clientRoot)
const assetImports = assets.map(({ file }) => `import ${JSON.stringify(`./client/${file}`)} with { type: "file" }`)
await safeOutput(compiledEntry)
await writeFile(
  compiledEntry,
  `${assetImports.join("\n")}\nimport { main } from "../cli/main"\nawait main()\n`,
)

const targets = [
  { target: "bun-darwin-arm64", output: "dist/trails-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dist/trails-darwin-x64" },
] as const

async function safeOutput(path: string) {
  try { await regularPath(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

for (const build of targets) {
  await safeOutput(resolve(build.output))
  const compile: Bun.CompileBuildOptions = {
    target: build.target,
    outfile: resolve(build.output),
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  }
  const result = await Bun.build({
    entrypoints: [compiledEntry],
    compile,
    minify: true,
    env: "disable",
    sourcemap: "none",
    naming: { asset: "[name].[ext]" },
  })
  if (!result.success) {
    for (const diagnostic of result.logs) console.error(diagnostic)
    throw new Error(`failed to build ${build.target}`)
  }
  const info = await stat(build.output)
  if (!info.isFile() || info.size === 0) throw new Error(`${build.output} was not created`)
  auditBinary(await readFile(build.output), build.target === "bun-darwin-arm64" ? "darwin-arm64" : "darwin-x64", assets)
  await chmod(build.output, 0o755)
  if (((await stat(build.output)).mode & 0o111) === 0) throw new Error(`${build.output} is not executable`)
  console.log(`built ${build.output}`)
}
