import { expect, test } from "bun:test"

// TRL-20–27, audited at 37f2864f624e16f8059615c70f621779597e4f7f.
// Keep checking nested copies too; a patched top-level package is insufficient.
// This regression guard complements, rather than replaces, a live dependency audit.
// Root overrides keep Ajv, Astro helpers, and PostCSS on patched compatible majors.
const affected: Record<string, string> = {
  astro: "<7.2.8",
  "extract-zip": "<=2.0.1",
  "fast-uri": ">=3.0.0 <3.1.6",
  "js-yaml": ">=4.0.0 <4.3.2",
  nanoid: "<3.3.18",
  sharp: "<0.35.4",
  svgo: ">=3.0.0 <3.3.5 || >=4.0.0 <4.1.0",
  undici: ">=7.0.0 <7.29.0",
}

function vulnerable(name: string, version: string): boolean {
  return Boolean(affected[name] && Bun.semver.satisfies(version, affected[name]!))
}

test("all Bun lockfile copies exclude the TRL-20–27 advisory ranges", async () => {
  const lock = Bun.JSONC.parse(await Bun.file(new URL("../bun.lock", import.meta.url)).text()) as {
    packages: Record<string, [string, ...unknown[]]>
  }
  const failures: string[] = []
  for (const [path, [resolution]] of Object.entries(lock.packages)) {
    const separator = resolution.lastIndexOf("@")
    const name = resolution.slice(0, separator)
    const version = resolution.slice(separator + 1)
    if (vulnerable(name, version)) failures.push(`${path}: ${resolution}`)
  }
  expect(failures).toEqual([])
})

test("all standalone BB plugin lockfile copies exclude the TRL-20–27 advisory ranges", async () => {
  const lock = await Bun.file(new URL("../plugins/bb-plugin-trails/package-lock.json", import.meta.url)).json() as {
    packages: Record<string, { name?: string; version?: string }>
  }
  const failures: string[] = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = entry.name ?? path.split("node_modules/").at(-1)!
    if (entry.version && vulnerable(name, entry.version)) failures.push(`${path}: ${entry.version}`)
  }
  expect(failures).toEqual([])
})
