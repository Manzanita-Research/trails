export const TRAILS_PROXY = "http://127.0.0.1:7412"

export type ExposureMode =
  | { readonly mode: "local" }
  | { readonly mode: "tailscale"; readonly service?: string }

export type ExposureState = { readonly version: 1 } & (ExposureMode | { readonly mode: "unverified" })

export interface ExposureClient {
  readonly run: (args: ReadonlyArray<string>) => { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  readonly host: (service?: string) => string
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("unable to verify Tailscale exposure: invalid Serve configuration")
  }
  return value as Record<string, unknown>
}

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  const result = object(value)
  if (Object.keys(result).some((key) => !allowed.includes(key))) {
    throw new Error("unable to verify Tailscale exposure: unsupported Serve configuration")
  }
  return result
}

function map(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : object(value)
}

export function parseExposureState(value: unknown): ExposureState {
  const state = fields(value, ["version", "mode", "service"])
  if (state.version === 1 && (state.mode === "local" || state.mode === "unverified") && state.service === undefined) {
    return { version: 1, mode: state.mode }
  }
  if (state.version === 1 && state.mode === "tailscale" &&
    (state.service === undefined || (typeof state.service === "string" && /^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(state.service)))) {
    return { version: 1, mode: "tailscale", service: state.service }
  }
  throw new Error("invalid saved Trails exposure state")
}

interface Route {
  readonly service?: string
  readonly hostPort: string
  readonly path: string
  readonly handler: Record<string, unknown>
  readonly https: boolean
  readonly foreground: boolean
  readonly funnel: boolean
}

// Accept the proxy address forms supported by Serve, including loopback aliases.
// Only the exact installer-created handler is removable; aliases require review.
function targetsTrails(target: unknown): boolean {
  if (target === undefined || target === "") return false
  if (typeof target !== "string") throw new Error("invalid Tailscale proxy target")
  if (target === "7412") return true
  try {
    const url = new URL(target.includes("://") ? target.replace(/^https\+insecure:/, "https:") : `http://${target}`)
    const hostname = url.hostname.replace(/\.$/, "")
    return url.port === "7412" && (["localhost", "0.0.0.0", "[::]", "[::1]", "[::ffff:7f00:1]"].includes(hostname) ||
      hostname.startsWith("127."))
  } catch {
    throw new Error("unable to verify Tailscale proxy target")
  }
}

function inspect(value: unknown, desired: ExposureMode, host?: string): Route[] {
  const routes: Route[] = []
  function visit(value: unknown, service?: string, foreground = false): void {
    const config = fields(value, service ? ["TCP", "Web", "Tun"] : ["TCP", "Web", "Services", "AllowFunnel", "Foreground"])
    if (config.Tun !== undefined && config.Tun !== false) throw new Error("Tailscale Tun exposure requires manual review")
    const tcp = map(config.TCP)
    for (const value of Object.values(tcp)) {
      const handler = fields(value, ["HTTPS", "HTTP", "TCPForward", "TerminateTLS", "ProxyProtocol"])
      if (targetsTrails(handler.TCPForward)) throw new Error("custom Trails TCP exposure requires manual removal")
    }
    const funnel = map(config.AllowFunnel)
    if (desired.mode === "tailscale" && service === desired.service) {
      const port = map(tcp["443"])
      if ((tcp["443"] && (foreground || port.HTTPS !== true || port.TCPForward || port.HTTP)) ||
        funnel[`${host}:443`] === true) {
        throw new Error("Tailscale port 443 is already in use or public; manual review required")
      }
    }
    for (const [hostPort, value] of Object.entries(map(config.Web))) {
      if (!/^.+:\d+$/.test(hostPort)) throw new Error("invalid Tailscale Web address")
      const port = hostPort.slice(hostPort.lastIndexOf(":") + 1)
      const https = map(tcp[port]).HTTPS === true
      const web = fields(value, ["Handlers"])
      for (const [path, value] of Object.entries(object(web.Handlers))) {
        const handler = fields(value, ["Proxy", "Path", "Text", "AcceptAppCaps", "Redirect"])
        routes.push({ service, hostPort, path, handler, https, foreground, funnel: funnel[hostPort] === true })
      }
    }
    for (const [name, value] of Object.entries(map(config.Services))) {
      if (!/^svc:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error("invalid Tailscale service name")
      visit(value, name, foreground)
    }
    for (const value of Object.values(map(config.Foreground))) visit(value, undefined, true)
  }
  // Tailscale serializes a missing Serve config as null.
  if (value !== null) visit(value)
  return routes
}

function readRoutes(client: ExposureClient, desired: ExposureMode): Route[] {
  const result = client.run(["serve", "status", "--json"])
  if (result.exitCode !== 0) throw new Error("unable to inspect Tailscale Serve status; exposure is unverified")
  let value: unknown
  try {
    value = JSON.parse(result.stdout)
  } catch {
    throw new Error("Tailscale Serve returned invalid status; exposure is unverified")
  }
  return inspect(value, desired, desired.mode === "tailscale" ? client.host(desired.service) : undefined)
}

function owned(route: Route): boolean {
  return !route.foreground && route.https && route.hostPort.endsWith(":443") && route.path === "/" &&
    Object.keys(route.handler).length === 1 && route.handler.Proxy === TRAILS_PROXY
}

function selected(route: Route, desired: ExposureMode): boolean {
  return desired.mode === "tailscale" && route.service === desired.service
}

function planRoutes(client: ExposureClient, desired: ExposureMode): Route[] {
  const routes = readRoutes(client, desired)
  const trails = routes.filter((route) => targetsTrails(route.handler.Proxy))
  for (const route of trails) {
    if (!owned(route) || route.hostPort !== `${client.host(route.service)}:443`) {
      throw new Error("custom or foreground Trails exposure requires manual removal")
    }
  }
  if (desired.mode === "tailscale") {
    const hostPort = `${client.host(desired.service)}:443`
    for (const route of routes) {
      if (route.service === desired.service && route.hostPort === hostPort && (route.path === "/" || route.path === "")) {
        if (!owned(route) || route.funnel) throw new Error("Tailscale Serve root is already in use or public; manual review required")
      }
    }
  }
  return trails
}

function command(service?: string): string[] {
  return ["serve", ...(service ? [`--service=${service}`] : ["--bg"]), "--https=443", "--set-path=/", "--yes"]
}

export function prepareExposure(
  desired: ExposureMode,
  client: ExposureClient | null,
  previous: ExposureState | null,
): { readonly description: string; readonly apply: () => ExposureState } {
  if (!client) {
    if (desired.mode === "tailscale" || previous?.mode === "tailscale") {
      throw new Error("Tailscale is required to inspect and reconcile network access")
    }
    return {
      description: "Loopback: http://127.0.0.1:7412/; Tailscale exposure unverified (CLI unavailable)",
      apply: () => ({ version: 1, mode: "unverified" }),
    }
  }
  const initial = planRoutes(client, desired)
  const removals = initial.filter((route) => !selected(route, desired)).length
  return {
    description: `Access plan: ${desired.mode === "local" ? "local" : desired.service ?? "Tailscale node"}; remove ${removals} Trails route(s), then verify`,
    apply: () => {
      // Reinspect immediately before changes; preflight may precede installation.
      for (const route of planRoutes(client, desired).filter((route) => !selected(route, desired))) {
        const result = client.run([...command(route.service), "off"])
        if (result.exitCode !== 0) throw new Error("failed to remove Trails Tailscale mapping; exposure is unverified")
      }
      if (desired.mode === "tailscale") {
        const result = client.run([...command(desired.service), TRAILS_PROXY])
        if (result.exitCode !== 0) throw new Error("failed to configure Tailscale Serve; exposure is unverified")
      }
      const remaining = planRoutes(client, desired)
      if (desired.mode === "local" ? remaining.length !== 0 : remaining.length !== 1 || !selected(remaining[0]!, desired)) {
        throw new Error("Tailscale exposure verification failed; requested access mode was not applied")
      }
      return { version: 1, ...desired }
    },
  }
}

export function exposureMessage(state: ExposureState): string {
  if (state.mode === "local") return "Access: local only at http://127.0.0.1:7412/ (Tailscale Serve verified)"
  if (state.mode === "unverified") return "Loopback: http://127.0.0.1:7412/; Tailscale exposure unverified (CLI unavailable)"
  return `Access: Tailscale ${state.service ?? "node"} (Serve verified)`
}
