import { describe, expect, test } from "bun:test"
import { exposureMessage, parseExposureState, prepareExposure, TRAILS_PROXY, type ExposureClient, type ExposureMode } from "../cli/exposure"

const nodeHost = "hub.example.ts.net"
const host = (service?: string) => service ? `${service.slice(4)}.example.ts.net` : nodeHost
const local = { mode: "local" } as const
const node = { mode: "tailscale" } as const
const named = { mode: "tailscale", service: "svc:trails" } as const

function web(service?: string, handlers: Record<string, unknown> = { "/": { Proxy: TRAILS_PROXY } }) {
  return { TCP: { "443": { HTTPS: true } }, Web: { [`${host(service)}:443`]: { Handlers: handlers } } }
}

function fixture(initial: unknown, options: { fail?: boolean; ignore?: boolean; invalidAfter?: boolean } = {}) {
  let config = structuredClone(initial) as any
  const calls: string[][] = []
  let mutated = false
  const client: ExposureClient = {
    host,
    run: (args) => {
      calls.push([...args])
      if (args[1] === "status") {
        return { exitCode: 0, stdout: options.invalidAfter && mutated ? "bad json" : JSON.stringify(config), stderr: "" }
      }
      mutated = true
      if (options.fail) return { exitCode: 1, stdout: "", stderr: "permission denied" }
      if (!options.ignore) {
        const service = args.find((arg) => arg.startsWith("--service="))?.slice(10)
        config ??= {}
        const scope = service ? ((config.Services ??= {})[service] ??= {}) : config
        const hp = `${host(service)}:443`
        if (args.at(-1) === "off") {
          // Simulate Serve's scoped root removal, retaining unrelated handlers.
          delete scope.Web[hp].Handlers["/"]
        } else {
          scope.TCP ??= {}
          scope.TCP["443"] = { HTTPS: true }
          scope.Web ??= {}
          scope.Web[hp] ??= { Handlers: {} }
          scope.Web[hp].Handlers["/"] = { Proxy: TRAILS_PROXY }
        }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    },
  }
  return { client, calls, config: () => config, mutations: () => calls.filter((args) => args[1] !== "status") }
}

describe("verified exposure transitions", () => {
  for (const service of [undefined, "svc:trails"]) {
    test(`removes only the ${service ?? "node"} root and verifies local mode`, () => {
      const handlers = { "/": { Proxy: TRAILS_PROXY }, "/other": { Proxy: "http://127.0.0.1:9000" } }
      const scope = web(service, handlers)
      const initial = service ? { Services: { [service]: scope, "svc:other": web("svc:other", { "/": { Text: "unrelated" } }) } } : scope
      const f = fixture(initial)
      const plan = prepareExposure(local, f.client, { version: 1, mode: "tailscale", service })
      expect(f.mutations()).toEqual([])
      expect(plan.description).not.toContain("local only")
      expect(plan.apply()).toEqual({ version: 1, mode: "local" })
      expect(f.mutations()).toEqual([["serve", service ? `--service=${service}` : "--bg", "--https=443", "--set-path=/", "--yes", "off"]])
      expect(f.calls.at(-1)).toEqual(["serve", "status", "--json"])
      const result = f.config()
      expect((service ? result.Services[service] : result).Web[`${host(service)}:443`].Handlers).toEqual({ "/other": handlers["/other"] })
      if (service) expect(result.Services["svc:other"]).toEqual((initial as any).Services["svc:other"])
    })
  }

  test("migrates legacy node and multiple service roots even without saved state", () => {
    const f = fixture({ ...web(), Services: { "svc:trails": web("svc:trails"), "svc:old": web("svc:old") } })
    expect(prepareExposure(local, f.client, null).apply().mode).toBe("local")
    expect(f.mutations()).toHaveLength(3)
  })

  for (const [initial, desired] of [
    [{}, node], [{}, named], [web(), named],
    [{ Services: { "svc:trails": web("svc:trails") } }, node],
    [{ Services: { "svc:old": web("svc:old") } }, named],
    [web(), node], [{ Services: { "svc:trails": web("svc:trails") } }, named],
  ] as [unknown, ExposureMode][]) {
    test(`reconciles ${JSON.stringify(initial)} to ${JSON.stringify(desired)}`, () => {
      const f = fixture(initial)
      expect(prepareExposure(desired, f.client, null).apply()).toEqual({ version: 1, ...desired })
      expect(f.mutations().at(-1)?.at(-1)).toBe(TRAILS_PROXY)
      expect(f.calls.at(-1)).toEqual(["serve", "status", "--json"])
    })
  }

  test("leaves unrelated node, service, TCP and foreground mappings intact", () => {
    const initial = {
      ...web(undefined, { "/": { Text: "hello" } }),
      Services: { "svc:other": { TCP: { "2222": { TCPForward: "127.0.0.1:22" } } } },
      Foreground: { "session-id": web(undefined, { "/": { Proxy: "http://localhost:9000" } }) },
    }
    const f = fixture(initial)
    expect(prepareExposure(local, f.client, null).apply().mode).toBe("local")
    expect(f.mutations()).toEqual([])
    expect(f.config()).toEqual(initial)
  })

  test("does not confuse unrelated node root with a requested service root", () => {
    const f = fixture(web(undefined, { "/": { Text: "hello" } }))
    expect(prepareExposure(named, f.client, null).apply().mode).toBe("tailscale")
    expect(f.config().Web).toEqual(web(undefined, { "/": { Text: "hello" } }).Web)
  })

  test("accepts empty and null status, inspecting even when saved mode is local", () => {
    for (const initial of [{}, null]) {
      const f = fixture(initial)
      expect(prepareExposure(local, f.client, { version: 1, mode: "local" }).apply().mode).toBe("local")
      expect(f.mutations()).toEqual([])
    }
  })

  test("reconciles live exposure even if the saved mode still says local", () => {
    const f = fixture(web())
    expect(prepareExposure(local, f.client, { version: 1, mode: "local" }).apply().mode).toBe("local")
    expect(f.mutations()).toHaveLength(1)
  })
})

describe("failed or ambiguous exposure", () => {
  for (const initial of [
    web(undefined, { "/custom": { Proxy: TRAILS_PROXY } }),
    ...["http://localhost:7412", "http://localhost.:7412", "http://0.0.0.0:7412", "http://127.0.0.1:7412/api", "http://[::1]:7412", "7412"].map((Proxy) => web(undefined, { "/": { Proxy } })),
    { Foreground: { session: web() } },
    { Foreground: { session: { Services: { "svc:trails": web("svc:trails") } } } },
    { TCP: { "443": { TCPForward: "localhost:7412" } } },
    { Services: { "svc:trails": { Tun: true } } },
    { TCP: { "80": { HTTP: true } }, Web: { [`${nodeHost}:80`]: { Handlers: { "/": { Proxy: TRAILS_PROXY } } } } },
    { ...web(), Web: { "old.example.ts.net:443": { Handlers: { "/": { Proxy: TRAILS_PROXY } } } } },
    { unexpected: {} }, [], { Services: [] }, { Web: { "bad": {} } },
  ]) {
    test(`refuses ambiguous exposure without mutation: ${JSON.stringify(initial)}`, () => {
      const f = fixture(initial)
      expect(() => prepareExposure(local, f.client, null)).toThrow()
      expect(f.mutations()).toEqual([])
    })
  }

  for (const service of [undefined, "svc:trails"]) {
    for (const handler of [{ Proxy: "http://localhost:9000" }, { Text: "hello" }, { Path: "/some/file" }]) {
      test(`protects unrelated ${service ?? "node"} root ${JSON.stringify(handler)}`, () => {
        const scope = web(service, { "/": handler })
        const f = fixture(service ? { Services: { [service]: scope } } : scope)
        expect(() => prepareExposure({ mode: "tailscale", service }, f.client, null)).toThrow("already in use")
        expect(f.mutations()).toEqual([])
      })
    }
  }

  test("protects existing TCP, foreground and Funnel settings before exposure", () => {
    for (const initial of [
      { TCP: { "443": { TCPForward: "localhost:9000" } } },
      { Foreground: { session: web(undefined, { "/other": { Text: "other" } }) } },
      { ...web(undefined, { "/other": { Text: "other" } }), AllowFunnel: { [`${nodeHost}:443`]: true } },
    ]) {
      const f = fixture(initial)
      expect(() => prepareExposure(node, f.client, null)).toThrow("already in use or public")
      expect(f.mutations()).toEqual([])
    }
  })

  for (const options of [{ fail: true }, { ignore: true }, { invalidAfter: true }]) {
    test(`does not confirm failed node or service removal: ${JSON.stringify(options)}`, () => {
      for (const initial of [web(), { Services: { "svc:trails": web("svc:trails") } }]) {
        const f = fixture(initial, options)
        const plan = prepareExposure(local, f.client, null)
        expect(() => plan.apply()).toThrow()
      }
    })
  }

  test("requires successful inspection and checks again after preflight", () => {
    for (const result of [{ exitCode: 1, stdout: "{}", stderr: "denied" }, { exitCode: 0, stdout: "bad", stderr: "" }]) {
      const client = { host, run: () => result }
      expect(() => prepareExposure(local, client, null)).toThrow()
    }
    const f = fixture(web())
    const plan = prepareExposure(local, f.client, null)
    f.config().Web[`${nodeHost}:443`].Handlers["/custom"] = { Proxy: TRAILS_PROXY }
    expect(() => plan.apply()).toThrow("manual removal")
    expect(f.mutations()).toEqual([])
  })

  test("does not confirm a successful command whose exposure never appeared", () => {
    const f = fixture({}, { ignore: true })
    expect(() => prepareExposure(node, f.client, null).apply()).toThrow("verification failed")
  })

  test("does not claim privacy without the CLI or forget previously exposed mode", () => {
    const state = prepareExposure(local, null, null).apply()
    expect(state).toEqual({ version: 1, mode: "unverified" })
    expect(exposureMessage(state)).toContain("unverified")
    expect(exposureMessage(state)).not.toContain("local only")
    expect(() => prepareExposure(local, null, { version: 1, ...node })).toThrow("required")
    expect(() => prepareExposure(local, null, { version: 1, ...named })).toThrow("required")
    expect(() => prepareExposure(node, null, null)).toThrow("required")
    expect(exposureMessage({ version: 1, mode: "local" })).toContain("local only")
  })

  test("validates persisted exposure modes", () => {
    for (const mode of [local, node, named, { mode: "unverified" } as const]) {
      const state = { version: 1 as const, ...mode }
      expect(parseExposureState(JSON.parse(JSON.stringify(state)))).toEqual(state)
    }
    for (const value of [null, {}, { version: 2, mode: "local" }, { version: 1, mode: "local", service: "svc:x" }, { version: 1, mode: "tailscale", service: "invalid" }]) {
      expect(() => parseExposureState(value)).toThrow()
    }
  })
})
