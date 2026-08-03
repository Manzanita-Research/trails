import packageJson from "../package.json" with { type: "json" }
import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const repository = process.env.TRAILS_RELEASE_REPOSITORY ?? "Manzanita-Research/homebrew-tap"
const output = resolve(process.argv[2] ?? "dist/homebrew/Formula/trails.rb")
const version = packageJson.version
const tag = `trails-v${version}`
const targets = {
  arm64: resolve("dist/trails-darwin-arm64"),
  x64: resolve("dist/trails-darwin-x64"),
} as const

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(await Bun.file(path).arrayBuffer())
  return hasher.digest("hex")
}

const [arm64Sha, x64Sha] = await Promise.all([sha256(targets.arm64), sha256(targets.x64)])
const releaseUrl = `https://github.com/${repository}/releases/download/${tag}`
const formula = `class Trails < Formula
  desc "Local-first memory system for coding-agent work"
  homepage "https://github.com/${repository}"
  url "${releaseUrl}/trails-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
  version "${version}"
  if Hardware::CPU.arm?
    sha256 "${arm64Sha}"
  else
    sha256 "${x64Sha}"
  end

  def install
    binary = "trails-darwin-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
    bin.install binary => "trails"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/trails version")
  end
end
`

await mkdir(dirname(output), { recursive: true })
await Bun.write(output, formula)
console.log(`wrote ${output}`)
console.log(`release tag ${tag}`)
console.log(`arm64 ${arm64Sha}`)
console.log(`x64 ${x64Sha}`)
