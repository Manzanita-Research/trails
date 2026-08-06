import { Schema } from "effect"
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { decodeExact } from "../shared/protocol"
import { PROVIDER_IDS, type ProviderId } from "../shared/providers"

export interface CollectorConfig {
  readonly protocolVersion: 1
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
}

const CollectorConfigSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  server: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
})
const LegacyServerConfigSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  aiUrl: Schema.String,
  aiToken: Schema.String,
})

export const COLLECTOR_CONFIG_PATH = join(homedir(), ".config/trails/collector.json")
export const SERVER_CONFIG_PATH = join(homedir(), ".config/trails/server.json")

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1"
}

export function normalizeCollectorServer(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("collector server must be a credential-free base URL with path /")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("collector server requires HTTPS except on loopback")
  }
  url.pathname = "/"
  return url.toString()
}


export function atomicWriteJson(path: string, value: unknown): void {
  const previousUmask = process.umask(0o077)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    const descriptor = openSync(temporary, "r")
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    chmodSync(temporary, 0o600)
    renameSync(temporary, path)
  } finally {
    process.umask(previousUmask)
  }
}

export function loadCollectorConfig(path = COLLECTOR_CONFIG_PATH): CollectorConfig | null {
  try {
    return decodeExact(CollectorConfigSchema, JSON.parse(readFileSync(path, "utf8"))) as CollectorConfig
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

export function configureCollector(options: {
  readonly server: string
  readonly name?: string
  readonly resetDeviceId?: boolean
  readonly path?: string
}): CollectorConfig {
  const path = options.path ?? COLLECTOR_CONFIG_PATH
  const existing = loadCollectorConfig(path)
  const deviceName = (options.name ?? existing?.deviceName ?? hostname()).trim()
  if (!deviceName || deviceName.length > 128) throw new Error("collector name must be 1..128 characters")
  const config: CollectorConfig = {
    protocolVersion: 1,
    server: normalizeCollectorServer(options.server),
    deviceId: !options.resetDeviceId && existing ? existing.deviceId : crypto.randomUUID(),
    deviceName,
  }
  atomicWriteJson(path, config)
  return config
}

export interface SummarizerConfig {
  readonly provider: ProviderId
  readonly model?: string
}

export interface HubAiConfig {
  readonly summarizer: SummarizerConfig | null
  /** True when the file still holds the retired V1 relay configuration. */
  readonly legacyRelay: boolean
}

const SummarizerSchema = Schema.Struct({
  provider: Schema.Literal(...PROVIDER_IDS),
  model: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))),
})
const ServerConfigV2Schema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  summarizer: Schema.NullOr(SummarizerSchema),
})

export function loadHubConfig(path = SERVER_CONFIG_PATH): HubAiConfig | null {
  let raw: string
  try {
    const info = statSync(path)
    const currentUid = process.getuid?.()
    if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
      throw new Error("server configuration permissions are unsafe")
    }
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw new Error("server configuration is invalid")
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "protocolVersion" in parsed &&
      parsed.protocolVersion === 1
    ) {
      decodeExact(LegacyServerConfigSchema, parsed)
      return { summarizer: null, legacyRelay: true }
    }
    const config = decodeExact(ServerConfigV2Schema, parsed)
    return { summarizer: config.summarizer, legacyRelay: false }
  } catch {
    throw new Error("server configuration is invalid")
  }
}

export function writeHubConfig(summarizer: SummarizerConfig | null, path = SERVER_CONFIG_PATH): void {
  if (summarizer !== null) decodeExact(SummarizerSchema, summarizer)
  let legacyRelay = false
  try {
    legacyRelay = loadHubConfig(path)?.legacyRelay ?? false
  } catch {
    // A corrupt or unsafe existing file is replaced outright with owner-only V2.
  }
  if (legacyRelay) {
    copyFileSync(path, `${path}.v1.bak`)
    chmodSync(`${path}.v1.bak`, 0o600)
  }
  atomicWriteJson(path, { protocolVersion: 2, summarizer })
}
