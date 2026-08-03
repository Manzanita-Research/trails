import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

const minimum = [1, 3, 14]
const current = Bun.version.split(".").map(Number)
for (let index = 0; index < minimum.length; index++) {
  if ((current[index] ?? 0) > minimum[index]) break
  if ((current[index] ?? 0) < minimum[index]) throw new Error("Bun 1.3.14 or newer is required")
}

await mkdir(resolve("dist"), { recursive: true })

async function filesUnder(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else files.push(path)
  }
  return files
}

const clientRoot = resolve("dist/client")
const compiledEntry = resolve("dist/compiled-entry.ts")
const assetImports = (await filesUnder(clientRoot))
  .sort()
  .map((path) => `import ${JSON.stringify(`./client/${relative(clientRoot, path)}`)} with { type: "file" }`)
await writeFile(
  compiledEntry,
  `${assetImports.join("\n")}\nimport { main } from "../cli/main"\nawait main()\n`,
)

const targets = [
  { target: "bun-darwin-arm64", output: "dist/trails-darwin-arm64" },
  { target: "bun-darwin-x64", output: "dist/trails-darwin-x64" },
] as const

for (const build of targets) {
  const compile: Bun.CompileBuildOptions & { readonly assets: ReadonlyArray<string> } = {
    target: build.target,
    outfile: resolve(build.output),
    assets: ["./dist/client"],
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  }
  const result = await Bun.build({
    entrypoints: [compiledEntry],
    compile,
    minify: true,
    naming: { asset: "[name].[ext]" },
  })
  if (!result.success) {
    for (const diagnostic of result.logs) console.error(diagnostic)
    throw new Error(`failed to build ${build.target}`)
  }
  const info = await stat(build.output)
  if (!info.isFile() || info.size === 0) throw new Error(`${build.output} was not created`)
  await chmod(build.output, 0o755)
  if (((await stat(build.output)).mode & 0o111) === 0) throw new Error(`${build.output} is not executable`)
  console.log(`built ${build.output}`)
}
