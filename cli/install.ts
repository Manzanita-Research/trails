import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { COLLECTOR_CONFIG_PATH, isLegacyProviderHubConfig, loadCollectorConfig, loadHubConfig, writeHubConfig } from "./config"
export type InstallKind = "server" | "collector"

export interface InstallOptions {
  readonly kind: InstallKind
  readonly dryRun?: boolean
  readonly service?: string
  readonly tailscale?: boolean
}

interface LaunchDefinition {
  readonly label: string
  readonly arguments: ReadonlyArray<string>
  readonly runAtLoad?: boolean
  readonly startInterval?: number
  readonly calendarHour?: number
  readonly keepAliveOnFailure?: boolean
}

const destination = join(homedir(), ".local/bin/trails")
const stateDirectory = join(homedir(), ".local/state/trails")
const launchAgentDirectory = join(homedir(), "Library/LaunchAgents")
const tailscaleProxy = "http://127.0.0.1:7412"
const legacyAuthPath = join(homedir(), ".config/trails/auth.json")
const legacyProviders = new Set(["openrouter", "chatgpt", "openai-api"])


function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function renderPlist(definition: LaunchDefinition): string {
  const argumentsXml = definition.arguments.map((argument) => `      <string>${xml(argument)}</string>`).join("\n")
  const keepAlive = definition.keepAliveOnFailure
    ? `\n    <key>KeepAlive</key>\n    <dict><key>SuccessfulExit</key><false/></dict>`
    : ""
  const interval = definition.startInterval
    ? `\n    <key>StartInterval</key><integer>${definition.startInterval}</integer>`
    : ""
  const calendar = definition.calendarHour !== undefined
    ? `\n    <key>StartCalendarInterval</key>\n    <dict><key>Hour</key><integer>${definition.calendarHour}</integer><key>Minute</key><integer>0</integer></dict>`
    : ""
  const runAtLoad = definition.runAtLoad ? "\n    <key>RunAtLoad</key><true/>" : ""
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${definition.label}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>${runAtLoad}${interval}${calendar}${keepAlive}
    <key>ProcessType</key><string>Background</string>
    <key>WorkingDirectory</key><string>${xml(stateDirectory)}</string>
    <key>StandardOutPath</key><string>${xml(join(stateDirectory, `${definition.label}.log`))}</string>
    <key>StandardErrorPath</key><string>${xml(join(stateDirectory, `${definition.label}.error.log`))}</string>
  </dict>
</plist>
`
}

function definitions(kind: InstallKind): LaunchDefinition[] {
  if (kind === "collector") {
    return [
      {
        label: "com.manzanita.trails.collector",
        arguments: [destination, "collect", "--once"],
        runAtLoad: true,
        startInterval: 60,
      },
    ]
  }
  return [
    {
      label: "com.manzanita.trails.server",
      arguments: [destination, "serve", "--port", "7412"],
      runAtLoad: true,
      keepAliveOnFailure: true,
    },
    {
      label: "com.manzanita.trails.backup",
      arguments: [
        destination,
        "backup",
        "--output-dir",
        join(homedir(), ".manzanita/trails/backups"),
        "--retain",
        "14",
      ],
      calendarHour: 3,
    },
  ]
}

function findRootProxy(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null
  for (const [key, child] of Object.entries(value)) {
    if (key === "/") {
      if (typeof child === "string") return child
      if (typeof child === "object" && child !== null) {
        for (const field of ["Proxy", "proxy", "Target", "target"]) {
          if (field in child && typeof child[field] === "string") return child[field]
        }
      }
    }
    const nested = findRootProxy(child)
    if (nested) return nested
  }
  return null
}

function run(executable: string, args: ReadonlyArray<string>): { readonly exitCode: number; readonly stdout: string; readonly stderr: string } {
  const result = Bun.spawnSync([executable, ...args], { stdout: "pipe", stderr: "pipe" })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

export function isMissingLaunchdService(stderr: string): boolean {
  return /not found|could not find service|no such process/i.test(stderr)
}

async function writableAncestor(path: string): Promise<void> {
  let candidate = resolve(path)
  while (true) {
    try {
      await stat(candidate)
      await access(candidate, constants.W_OK)
      return
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        const parent = dirname(candidate)
        if (parent === candidate) throw new Error(`no writable ancestor for ${path}`)
        candidate = parent
        continue
      }
      throw error
    }
  }
}

async function atomicCopy(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    if ((await realpath(source)) === (await realpath(target))) return
  } catch {}
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  await copyFile(source, temporary)
  await chmod(temporary, 0o700)
  const handle = await open(temporary, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
}

async function atomicText(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await open(temporary, "wx", 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

function tailscalePath(): string | null {
  return Bun.which("tailscale") ?? (Bun.file("/Applications/Tailscale.app/Contents/MacOS/Tailscale").size > 0
    ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
    : null)
}

export function normalizeTailscaleService(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("Tailscale service must be svc:<dns-label>")
  }
  return value
}

export function currentTailnetUrl(service?: string): string {
  const normalizedService = normalizeTailscaleService(service)
  const executable = tailscalePath()
  if (!executable) throw new Error("Tailscale is required")
  const status = run(executable, ["status", "--json"])
  if (status.exitCode !== 0) throw new Error("unable to inspect Tailscale status")
  let value: unknown
  try {
    value = JSON.parse(status.stdout)
  } catch {
    throw new Error("Tailscale returned invalid status")
  }
  const self = typeof value === "object" && value !== null && "Self" in value ? value.Self : null
  const dnsName = typeof self === "object" && self !== null && "DNSName" in self ? self.DNSName : null
  if (typeof dnsName !== "string" || !dnsName) throw new Error("Tailscale did not report a MagicDNS name")
  const nodeName = dnsName.replace(/\.$/, "")
  if (!normalizedService) return `https://${nodeName}/`
  const separator = nodeName.indexOf(".")
  if (separator < 0) throw new Error("Tailscale did not report a complete MagicDNS name")
  return `https://${normalizedService.slice(4)}${nodeName.slice(separator)}/`
}

function isLegacyCredential(value: unknown): boolean {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  if (value.type === "api") {
    return Object.keys(value).every((key) => key === "type" || key === "key") &&
      "key" in value && typeof value.key === "string" && value.key.length > 0
  }
  if (value.type !== "oauth") return false
  return Object.keys(value).every((key) => ["type", "access", "refresh", "expires", "accountId"].includes(key)) &&
    "access" in value && typeof value.access === "string" && value.access.length > 0 &&
    "refresh" in value && typeof value.refresh === "string" && value.refresh.length > 0 &&
    "expires" in value && typeof value.expires === "number" &&
    (!("accountId" in value) || typeof value.accountId === "string")
}

async function validatedLegacyFile(path: string, validate: (value: unknown) => boolean): Promise<{
  readonly dev: number
  readonly ino: number
} | null> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  const currentUid = process.getuid?.()
  if (!info.isFile() || info.isSymbolicLink() || (currentUid !== undefined && info.uid !== currentUid) ||
    (info.mode & 0o777) !== 0o600 || info.size > 64 * 1024) {
    throw new Error(`legacy Trails file requires manual removal: ${path}`)
  }
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, "utf8"))
  } catch {
    throw new Error(`legacy Trails file requires manual removal: ${path}`)
  }
  if (!validate(value)) throw new Error(`legacy Trails file requires manual removal: ${path}`)
  return { dev: info.dev, ino: info.ino }
}

function isLegacyAuth(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Object.keys(value).some((key) => !["protocolVersion", "providers"].includes(key))) {
    return false
  }
  if (!("protocolVersion" in value) || value.protocolVersion !== 1 || !("providers" in value) ||
    typeof value.providers !== "object" || value.providers === null) return false
  return Object.entries(value.providers).every(([provider, credential]) =>
    legacyProviders.has(provider) && isLegacyCredential(credential)
  )
}

async function removeValidatedLegacyFile(path: string, expected: { readonly dev: number; readonly ino: number }): Promise<void> {
  const current = await lstat(path)
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(`legacy Trails file changed during upgrade: ${path}`)
  }
  await unlink(path)
}

export async function retireLegacyProviderConfig(options: {
  readonly authPath?: string
  readonly configPath?: string
} = {}): Promise<boolean> {
  const authPath = options.authPath ?? legacyAuthPath
  const configPath = options.configPath
  const auth = await validatedLegacyFile(authPath, isLegacyAuth)
  const configIsLegacy = isLegacyProviderHubConfig(configPath)
  if (auth === null && !configIsLegacy) return false
  if (auth !== null) {
    await removeValidatedLegacyFile(authPath, auth)
    const directory = await open(dirname(authPath), "r")
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  if (configIsLegacy) writeHubConfig(null, configPath)
  return true
}

export async function install(options: InstallOptions): Promise<void> {
  const standalone = "isStandaloneExecutable" in Bun
    ? Bun.isStandaloneExecutable === true
    : Bun.main.startsWith("/$bunfs/")
  if (!standalone) throw new Error("install is available only from a compiled trails executable")
  const launchctl = Bun.which("launchctl")
  if (!launchctl) throw new Error("launchctl is required")
  if (options.kind === "collector" && !loadCollectorConfig(COLLECTOR_CONFIG_PATH)) {
    throw new Error("collector configuration is required before installation")
  }
  let aiConfig: unknown = null
  let legacyProviderConfig = false
  if (options.kind === "server") {
    legacyProviderConfig = isLegacyProviderHubConfig()
    if (!legacyProviderConfig) aiConfig = loadHubConfig()?.summarizer ?? null
  }
  const service = options.kind === "server" ? normalizeTailscaleService(options.service) : undefined
  const exposeThroughTailscale = options.kind === "server" && (options.tailscale === true || service !== undefined)
  const tailscale = exposeThroughTailscale ? tailscalePath() : null
  if (exposeThroughTailscale && !tailscale) throw new Error("Tailscale is required for private network access")
  await writableAncestor(destination)
  await writableAncestor(launchAgentDirectory)
  await writableAncestor(stateDirectory)

  if (tailscale && !service) {
    const status = run(tailscale, ["serve", "status", "--json"])
    if (status.exitCode !== 0) throw new Error("unable to inspect Tailscale Serve status")
    let rootProxy: string | null
    try {
      rootProxy = findRootProxy(JSON.parse(status.stdout) as unknown)
    } catch {
      throw new Error("Tailscale Serve returned invalid status")
    }
    if (rootProxy && rootProxy !== tailscaleProxy) {
      throw new Error(`Tailscale Serve root already points to ${rootProxy}`)
    }
  }

  const planned = definitions(options.kind)
  console.log(`Executable: ${process.execPath} -> ${destination}`)
  for (const definition of planned) {
    console.log(`LaunchAgent ${definition.label}: ${definition.arguments.join(" ")}`)
  }
  if (options.kind === "server") {
    if (exposeThroughTailscale) {
      console.log(`Tailscale preflight: ${service ? `${service} https:443` : "node root"} -> ${tailscaleProxy}`)
    } else {
      console.log("Access: local only at http://127.0.0.1:7412/")
    }
    if (!aiConfig) console.warn("Summaries are off; run `trails summaries use auto` on the hub to enable them")
  }
  if (options.dryRun) return
  if (options.kind === "server" && legacyProviderConfig) {
    const domain = `gui/${process.getuid?.() ?? 0}`
    const bootout = run(launchctl, ["bootout", `${domain}/com.manzanita.trails.server`])
    if (bootout.exitCode !== 0 && !isMissingLaunchdService(bootout.stderr)) {
      throw new Error("failed to stop com.manzanita.trails.server")
    }
    await retireLegacyProviderConfig()
    console.warn("Retired Trails-owned provider credentials; revoke the old provider keys or sessions in their provider accounts")
  }

  await atomicCopy(process.execPath, destination)
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
  await mkdir(launchAgentDirectory, { recursive: true, mode: 0o700 })
  for (const definition of planned) {
    for (const suffix of [".log", ".error.log"]) {
      const handle = await open(join(stateDirectory, `${definition.label}${suffix}`), "a", 0o600)
      await handle.close()
      await chmod(join(stateDirectory, `${definition.label}${suffix}`), 0o600)
    }
    const plistPath = join(launchAgentDirectory, `${definition.label}.plist`)
    await atomicText(plistPath, renderPlist(definition))
    const domain = `gui/${process.getuid?.() ?? 0}`
    const service = `${domain}/${definition.label}`
    const bootout = run(launchctl, ["bootout", service])
    if (bootout.exitCode !== 0 && !isMissingLaunchdService(bootout.stderr)) {
      throw new Error(`failed to stop ${definition.label}`)
    }
    let bootstrap = run(launchctl, ["bootstrap", domain, plistPath])
    for (const delay of [250, 500, 1_000, 2_000, 4_000]) {
      if (bootstrap.exitCode === 0) break
      await Bun.sleep(delay)
      bootstrap = run(launchctl, ["bootstrap", domain, plistPath])
    }
    if (bootstrap.exitCode !== 0) throw new Error(`failed to load ${definition.label}: ${bootstrap.stderr.trim()}`)
    const kickstart = run(launchctl, ["kickstart", "-k", service])
    if (kickstart.exitCode !== 0) throw new Error(`failed to start ${definition.label}`)
  }
  if (tailscale) {
    const args = service
      ? ["serve", `--service=${service}`, "--https=443", "--yes", tailscaleProxy]
      : ["serve", "--bg", "--yes", tailscaleProxy]
    const applied = run(tailscale, args)
    if (applied.exitCode !== 0) {
      throw new Error(`failed to configure Tailscale Serve: ${applied.stderr.trim()}`)
    }
  }
}
