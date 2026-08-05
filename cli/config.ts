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

export interface GranolaCollectorConfig {
  readonly binaryPath: string
  readonly initialCreatedAfter: string
}

export interface CollectorConfig {
  readonly protocolVersion: 2
  readonly server: string
  readonly deviceId: string
  readonly deviceName: string
  readonly granola: GranolaCollectorConfig | null
}

export interface ServerConfig {
  readonly protocolVersion: 1
  readonly aiUrl: string
  readonly aiToken: string
}

const CollectorConfigV1Schema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  server: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
})
const GranolaCollectorConfigSchema = Schema.Struct({
  binaryPath: Schema.String,
  initialCreatedAfter: Schema.String,
})
const CollectorConfigSchema = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  server: Schema.String,
  deviceId: Schema.String,
  deviceName: Schema.String,
  granola: Schema.NullOr(GranolaCollectorConfigSchema),
})
const ServerConfigSchema = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  aiUrl: Schema.String,
  aiToken: Schema.String,
})

export const COLLECTOR_CONFIG_PATH = join(homedir(), ".config/trails/collector.json")
export const DEFAULT_GRANOLA_CLI_PATH = "/Applications/Granola.app/Contents/Resources/bin/granola"
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

export function normalizeInferenceUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/summarize") {
    throw new Error("AI URL must be the credential-free /api/summarize endpoint")
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error("AI URL requires HTTPS except on loopback")
  }
  return url.toString()
}

function atomicWrite(path: string, value: unknown): void {
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
    const info = statSync(path)
    const currentUid = process.getuid?.()
    if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
      throw new Error("collector configuration permissions are unsafe")
    }
    const input: unknown = JSON.parse(readFileSync(path, "utf8"))
    let config: CollectorConfig
    try {
      config = decodeExact(CollectorConfigSchema, input) as CollectorConfig
    } catch {
      const legacy = decodeExact(CollectorConfigV1Schema, input)
      config = { ...legacy, protocolVersion: 2, granola: null }
    }
    if (normalizeCollectorServer(config.server) !== config.server) {
      throw new Error("collector configuration is invalid")
    }
    if (config.granola) validateGranolaConfig(config.granola)
    return config
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw new Error("collector configuration is invalid")
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
    protocolVersion: 2,
    server: normalizeCollectorServer(options.server),
    deviceId: !options.resetDeviceId && existing ? existing.deviceId : crypto.randomUUID(),
    deviceName,
    granola: existing?.granola ?? null,
  }
  atomicWrite(path, config)
  return config
}

function validateGranolaConfig(config: GranolaCollectorConfig): void {
  if (!config.binaryPath.startsWith("/")) throw new Error("Granola CLI path must be absolute")
  const parsed = new Date(config.initialCreatedAfter)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== config.initialCreatedAfter) {
    throw new Error("Granola created-after must be a canonical UTC timestamp with milliseconds")
  }
}

export function configureGranola(options: {
  readonly initialCreatedAfter: string
  readonly binaryPath?: string
  readonly path?: string
}): CollectorConfig {
  const path = options.path ?? COLLECTOR_CONFIG_PATH
  const existing = loadCollectorConfig(path)
  if (!existing) throw new Error("configure the collector target before Granola")
  const granola: GranolaCollectorConfig = {
    binaryPath: options.binaryPath ?? DEFAULT_GRANOLA_CLI_PATH,
    initialCreatedAfter: options.initialCreatedAfter,
  }
  validateGranolaConfig(granola)
  const config: CollectorConfig = { ...existing, granola }
  atomicWrite(path, config)
  return config
}

export function disableGranola(path = COLLECTOR_CONFIG_PATH): CollectorConfig {
  const existing = loadCollectorConfig(path)
  if (!existing) throw new Error("configure the collector target before Granola")
  const config: CollectorConfig = { ...existing, granola: null }
  atomicWrite(path, config)
  return config
}

export function configureServer(options: {
  readonly aiUrl: string
  readonly aiToken: string
  readonly path?: string
}): ServerConfig {
  const token = options.aiToken.replace(/\r?\n$/, "")
  if (!token) throw new Error("AI token must not be empty")
  const config: ServerConfig = {
    protocolVersion: 1,
    aiUrl: normalizeInferenceUrl(options.aiUrl),
    aiToken: token,
  }
  atomicWrite(options.path ?? SERVER_CONFIG_PATH, config)
  return config
}

export function loadServerConfig(path = SERVER_CONFIG_PATH): ServerConfig | null {
  try {
    const info = statSync(path)
    const currentUid = process.getuid?.()
    if (!info.isFile() || (currentUid !== undefined && info.uid !== currentUid) || (info.mode & 0o077) !== 0) {
      throw new Error("server configuration permissions are unsafe")
    }
    const config = decodeExact(ServerConfigSchema, JSON.parse(readFileSync(path, "utf8"))) as ServerConfig
    if (normalizeInferenceUrl(config.aiUrl) !== config.aiUrl || !config.aiToken) {
      throw new Error("server configuration is invalid")
    }
    return config
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw new Error("server configuration is invalid")
  }
}
