import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
} from "node:fs/promises"
import { constants } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { COLLECTOR_CONFIG_PATH, loadCollectorConfig, loadServerConfig } from "./config"

export type InstallKind = "server" | "collector"

export interface InstallOptions {
  readonly kind: InstallKind
  readonly dryRun?: boolean
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
  const aiConfig = options.kind === "server" ? loadServerConfig() : null
  const tailscale = options.kind === "server" ? tailscalePath() : null
  if (options.kind === "server" && !tailscale) throw new Error("Tailscale is required for server installation")
  await writableAncestor(destination)
  await writableAncestor(launchAgentDirectory)
  await writableAncestor(stateDirectory)

  if (tailscale) {
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
    console.log(`Tailscale preflight: root -> ${tailscaleProxy}`)
    if (!aiConfig) console.warn("AI is disabled; summary jobs will remain pending")
  }
  if (options.dryRun) return

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
    const bootstrap = run(launchctl, ["bootstrap", domain, plistPath])
    if (bootstrap.exitCode !== 0) throw new Error(`failed to load ${definition.label}`)
    const kickstart = run(launchctl, ["kickstart", "-k", service])
    if (kickstart.exitCode !== 0) throw new Error(`failed to start ${definition.label}`)
  }
  if (tailscale) {
    const applied = run(tailscale, ["serve", "--bg", "--yes", tailscaleProxy])
    if (applied.exitCode !== 0) throw new Error("failed to configure Tailscale Serve")
  }
}
