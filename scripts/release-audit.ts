import { lstat, readdir, readFile } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"

export const architectures = ["darwin-arm64", "darwin-x64"] as const
export type Architecture = typeof architectures[number]
export interface FileRecord { file: string; size: number; sha256: string }
export const fonts = [
  "commit-mono-variable", "general-sans-400", "general-sans-500", "general-sans-600",
  "literata-400", "literata-400-italic", "recia-400", "recia-400-italic",
  "switzer-300", "switzer-400", "switzer-500", "switzer-600",
].map((name) => `fonts/${name}.woff2`)
export const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
export const record = (file: string, bytes: Uint8Array): FileRecord => ({ file, size: bytes.length, sha256: digest(bytes) })
export function requireAudit(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`release audit: ${message}`)
}

// Check every component: lstat on the leaf alone misses a symlinked parent.
export async function regularPath(path: string, directory = false): Promise<void> {
  const absolute = resolve(path)
  let component: string = sep
  for (const name of absolute.split(sep).filter(Boolean)) {
    component = join(component, name)
    const info = await lstat(component)
    requireAudit(!info.isSymbolicLink(), "symlinks are forbidden")
    requireAudit(component === absolute && !directory ? info.isFile() && info.size > 0 : info.isDirectory(), "expected regular nonempty file or directory")
  }
}

export function auditPrivacy(bytes: Uint8Array, personalPaths = true): void {
  const text = Buffer.from(bytes).toString("latin1")
  const rules: [string, RegExp][] = [
    ["private fixture", /SYNTHETIC_PRIVATE_PAYLOAD|TRAILS_PRIVATE_(?:PAYLOAD|TRANSCRIPT|DIGEST)/],
    ["private key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ["credential", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
    ["credential assignment", /(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["'][A-Za-z0-9_+\/-]{16,}["']/i],
    ["private endpoint", /(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b|https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)\d)/i],
  ]
  if (!personalPaths) {
    // Only known upstream CI source locations may survive in the native runtime.
    // No such exception applies to the embedded product graph.
    const paths = text.match(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s\x00"'<>]+/g) ?? []
    const upstream = /^\/Users\/(?:runner\/work\/_temp\/webkit-release\/[A-Za-z0-9_./-]+\.(?:h|cpp)(?::[0-9]+:[0-9]+\)\])?|administrator\/(?:Library\/Services\/buildkite-agent\/builds\/darwin-aarch64-15-1-1\/bun\/bun\/vendor\/lolhtml\/src\/[A-Za-z0-9_./-]+\.rs|\.cargo\/registry\/src\/index\.crates\.io-1949cf8c6b5b557f\/[A-Za-z0-9_./-]+\.rs|\.rustup\/toolchains\/nightly-2025-12-10-x86_64-apple-darwin\/lib\/rustlib\/src\/rust\/library\/[A-Za-z0-9_./-]+\.rs))$/
    for (const path of paths) requireAudit(upstream.test(path), "unexpected native personal path (withheld)")
  }
  if (personalPaths) rules.push(
    ["personal path", /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[A-Za-z0-9_.-]+/],
    ["source map", /[#@]\s*sourceMappingURL\s*=|"sourcesContent"\s*:/],
    ["transcript", /"(?:session_meta|event_msg|response_item)"\s*[,}]|"(?:digest|transcript)"\s*:\s*"[^"\n]{32,}"/],
    ["source history", /(?:^|\n)(?:commit [a-f0-9]{40}\n|ref: refs\/heads\/)/],
  )
  for (const [name, pattern] of rules) requireAudit(!pattern.test(text), `forbidden ${name} (matched values withheld)`)
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key) && value && value.length >= 8) {
      requireAudit(!text.includes(value), "embedded sensitive environment value (withheld)")
    }
  }
  // Upstream Bun contains its own CI paths; never exempt those in product payloads.
  for (const value of [process.env.HOME, process.cwd()]) {
    if (value && value.length > 4) requireAudit(!text.includes(value), "embedded operator path (withheld)")
  }
}

export async function auditClient(root: string): Promise<FileRecord[]> {
  await regularPath(root, true)
  const files: FileRecord[] = []
  async function visit(directory: string, prefix = "") {
    for (const name of (await readdir(directory)).sort()) {
      const file = prefix + name
      const path = join(directory, name)
      const info = await lstat(path)
      requireAudit(!info.isSymbolicLink(), "symlinks are forbidden")
      if (info.isDirectory()) {
        requireAudit(file === "assets" || file === "fonts", "unexpected asset directory")
        await visit(path, `${file}/`)
      } else {
        requireAudit(info.isFile() && info.size > 0, "asset must be a nonempty regular file")
        requireAudit(file === "index.html" || fonts.includes(file) || /^assets\/index-[A-Za-z0-9_-]{8}\.(?:js|css)$/.test(file), "unexpected client asset")
        const bytes = await readFile(path)
        auditPrivacy(bytes)
        if (file.endsWith(".woff2")) requireAudit(bytes.subarray(0, 4).toString() === "wOF2", "invalid font")
        files.push(record(file, bytes))
      }
    }
  }
  await visit(root)
  requireAudit(files.length === fonts.length + 3 && [...fonts, "index.html"].every((name) => files.some((f) => f.file === name)) &&
    ["js", "css"].every((ext) => files.filter((f) => f.file.endsWith(`.${ext}`)).length === 1), "incomplete or duplicate client assets")
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

export function auditVersion(version: unknown): asserts version is string {
  requireAudit(typeof version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?$/.test(version) && version.length <= 128, "unsafe release version")
}

export function assetByEmbeddedName(assets: FileRecord[]): Map<string, FileRecord> {
  return new Map(assets.map((asset) => [`/$bunfs/root/${basename(asset.file)}`, asset]))
}
