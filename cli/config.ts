import { readPrivateFile } from "../server/auth"
import { Schema } from "effect"
import {
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
import { HARNESS_IDS, type HarnessSelection } from "../shared/harnesses"

export interface CollectorConfig {
  readonly protocolVersion: 1
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
  readonly token?: string
}

const CollectorConfigSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  server: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  token: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/))),
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
    return decodeExact(CollectorConfigSchema, JSON.parse(readPrivateFile(path))) as CollectorConfig
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw new Error("collector configuration is invalid or its permissions are unsafe")
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
    ...(!options.resetDeviceId && existing?.server === normalizeCollectorServer(options.server) && existing.token
      ? { token: existing.token } : {}),
  }
  atomicWriteJson(path, config)
  return config
}

export interface SummarizerConfig {
  readonly harness: HarnessSelection
}

export interface HubAiConfig {
  readonly summarizer: SummarizerConfig | null
}

const SummarizerSchema = Schema.Struct({
  harness: Schema.Literal("auto", ...HARNESS_IDS),
})
const ServerConfigV3Schema = Schema.Struct({
  protocolVersion: Schema.Literal(3),
  summarizer: Schema.NullOr(SummarizerSchema),
})
const ServerConfigV2Schema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  summarizer: Schema.NullOr(Schema.Struct({
    provider: Schema.Literal("openrouter", "chatgpt", "openai-api"),
    model: Schema.optional(Schema.String),
  })),
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
    const config = decodeExact(ServerConfigV3Schema, JSON.parse(raw))
    return { summarizer: config.summarizer }
  } catch {
    throw new Error("server configuration is invalid")
  }
}
export function isLegacyProviderHubConfig(path = SERVER_CONFIG_PATH): boolean {
  let raw: string
  try {
    const info = statSync(path)
    const currentUid = process.getuid?.()
    if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
      throw new Error("server configuration permissions are unsafe")
    }
    raw = readFileSync(path, "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false
    throw new Error("server configuration is invalid")
  }
  try {
    decodeExact(ServerConfigV2Schema, JSON.parse(raw))
    return true
  } catch {
    return false
  }
}


export function writeHubConfig(summarizer: SummarizerConfig | null, path = SERVER_CONFIG_PATH): void {
  if (summarizer !== null) decodeExact(SummarizerSchema, summarizer)
  atomicWriteJson(path, { protocolVersion: 3, summarizer })
}

export function importCollectorPairing(pairingPath: string, server: string, path = COLLECTOR_CONFIG_PATH): CollectorConfig {
  const config = loadCollectorConfig(pairingPath)
  if (!config?.token || normalizeCollectorServer(config.server) !== normalizeCollectorServer(server)) {
    throw new Error("pairing file must contain a credential for this exact hub URL")
  }
  atomicWriteJson(path, { ...config, server: normalizeCollectorServer(server) })
  return config
}
