import { assetByEmbeddedName, auditPrivacy, digest, record, requireAudit, type Architecture, type FileRecord } from "./release-audit"

// Fail closed on unfamiliar formats. Layout: Bun v1.3.14's
// src/standalone_graph/StandaloneModuleGraph.zig and src/exe_format/macho.zig.
// Static inspection works for both CPUs without executing release candidates.
export function auditBinary(bytes: Buffer, architecture: Architecture, assets: FileRecord[]) {
  const u32 = (offset: number) => { bounds(offset, 4); return bytes.readUInt32LE(offset) }
  const u64 = (offset: number) => { bounds(offset, 8); const n = Number(bytes.readBigUInt64LE(offset)); requireAudit(Number.isSafeInteger(n), "invalid Mach-O integer"); return n }
  function bounds(offset: number, size: number) {
    requireAudit(offset >= 0 && size >= 0 && offset + size <= bytes.length, "truncated Mach-O")
  }
  requireAudit(bytes.length >= 32 && u32(0) === 0xfeedfacf && u32(12) === 2, "expected thin 64-bit Mach-O executable")
  requireAudit(u32(4) === (architecture === "darwin-arm64" ? 0x100000c : 0x1000007), "wrong Mach-O architecture")
  const commandsEnd = 32 + u32(20)
  bounds(32, u32(20))
  let cursor = 32
  let graph: Buffer | undefined
  let hasEntry = false
  for (let i = 0; i < u32(16); i++) {
    requireAudit(cursor + 8 <= commandsEnd, "invalid load commands")
    const command = u32(cursor), size = u32(cursor + 4)
    requireAudit(size >= 8 && size % 8 === 0 && cursor + size <= commandsEnd, "invalid load command size")
    if (command === 0x80000028) hasEntry = true // LC_MAIN
    if (command === 0x19) { // LC_SEGMENT_64
      requireAudit(size >= 72, "invalid segment")
      bounds(u64(cursor + 40), u64(cursor + 48))
      const count = u32(cursor + 64)
      requireAudit(72 + count * 80 === size, "invalid sections")
      for (let j = 0; j < count; j++) {
        const section = cursor + 72 + j * 80
        const name = bytes.subarray(section, section + 16).toString().replace(/\0.*$/, "")
        const segment = bytes.subarray(section + 16, section + 32).toString().replace(/\0.*$/, "")
        if (name !== "__bun" || segment !== "__BUN") continue
        requireAudit(!graph, "duplicate Bun graph")
        const offset = u32(section + 48), sectionSize = u64(section + 40)
        bounds(offset, sectionSize)
        const length = u64(offset)
        requireAudit(length + 8 === sectionSize, "invalid Bun section size")
        graph = bytes.subarray(offset + 8, offset + 8 + length)
      }
    }
    cursor += size
  }
  requireAudit(cursor === commandsEnd && hasEntry && graph, "missing executable entry or Bun payload")
  auditPrivacy(bytes, false)
  auditPrivacy(graph)
  const trailer = Buffer.from("\n---- Bun! ----\n")
  requireAudit(graph.length >= 48 && graph.subarray(-16).equals(trailer), "unsupported Bun graph trailer")
  const offsets = graph.length - 48
  const byteCount = Number(graph.readBigUInt64LE(offsets))
  const modulesOffset = graph.readUInt32LE(offsets + 8), modulesSize = graph.readUInt32LE(offsets + 12)
  const entry = graph.readUInt32LE(offsets + 16)
  requireAudit(byteCount === offsets && modulesSize > 0 && modulesSize % 52 === 0 && modulesOffset + modulesSize + 1 === offsets, "unsupported Bun module table")
  requireAudit(entry === 0 && graph.readUInt32LE(offsets + 20) === offsets - 1 && graph.readUInt32LE(offsets + 24) === 0 && graph[offsets - 1] === 0, "unexpected compiled arguments or entry")
  requireAudit(graph.readUInt32LE(offsets + 28) === 15, "Bun config autoload must be disabled")
  const expected = assetByEmbeddedName(assets)
  const embedded: FileRecord[] = []
  let dataEnd = 0
  for (let pos = modulesOffset; pos < modulesOffset + modulesSize; pos += 52) {
    function stringAt(pointer: number) {
      const start = graph!.readUInt32LE(pointer), length = graph!.readUInt32LE(pointer + 4)
      requireAudit(start === dataEnd && start + length < modulesOffset && graph![start + length] === 0, "unexpected or overlapping embedded data")
      dataEnd = start + length + 1
      return graph!.subarray(start, start + length)
    }
    const name = stringAt(pos).toString("utf8")
    const content = stringAt(pos + 8)
    requireAudit(graph.subarray(pos + 16, pos + 48).every((byte) => byte === 0), "source maps, bytecode or extra module metadata forbidden")
    if (pos === modulesOffset) {
      requireAudit(name === "/$bunfs/root/compiled-entry.js" && content.length > 0 && graph.subarray(pos + 48, pos + 52).equals(Buffer.from([1, 1, 1, 0])), "unexpected compiled entry")
    } else {
      const asset = expected.get(name)
      requireAudit(asset && asset.size === content.length && asset.sha256 === digest(content), "unexpected or changed embedded asset")
      requireAudit(graph.subarray(pos + 48, pos + 52).equals(Buffer.from([0, 5, 0, 1])), "unexpected asset loader")
      expected.delete(name)
    }
    embedded.push(record(name, content))
  }
  requireAudit(dataEnd === modulesOffset && expected.size === 0, "unaccounted or missing embedded files")
  return { architecture, format: "Mach-O 64-bit executable", graphFormat: "bun-v1.3.14", embedded }
}
