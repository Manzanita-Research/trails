import { describe, expect, test } from "bun:test"
import { runSetup, type SetupActions } from "../cli/setup"

function recordingActions(events: string[], waitFailure?: Error): SetupActions {
  return {
    configureCollector: (server, name) => events.push(`configure:${server}:${name ?? "default"}`),
    install: async (kind, service) => { events.push(`install:${kind}:${service ?? "node"}`) },
    collect: async () => { events.push("collect") },
    waitForServer: async (server) => {
      events.push(`wait:${server}`)
      if (waitFailure) throw waitFailure
    },
    tailnetUrl: (service) => {
      events.push(`tailnet-url:${service ?? "node"}`)
      return service ? "https://trails.example.ts.net/" : "https://hub.example.ts.net/"
    },
  }
}

describe("one-command setup", () => {
  test("starts a hub before indexing and scheduling its collector", async () => {
    const events: string[] = []
    const url = await runSetup({ mode: "hub", name: "Home Hub" }, recordingActions(events))

    expect(url).toBe("https://hub.example.ts.net/")
    expect(events).toEqual([
      "configure:http://127.0.0.1:7412/:Home Hub",
      "install:server:node",
      "wait:http://127.0.0.1:7412/",
      "collect",
      "install:collector:node",
      "tailnet-url:node",
    ])
  })

  test("threads an explicit stable Tailscale service through hub setup", async () => {
    const events: string[] = []
    const url = await runSetup(
      { mode: "hub", name: "Home Hub", service: "svc:trails" },
      recordingActions(events),
    )

    expect(url).toBe("https://trails.example.ts.net/")
    expect(events).toContain("install:server:svc:trails")
    expect(events).toContain("tailnet-url:svc:trails")
    expect(events).toContain("wait:https://trails.example.ts.net/")
  })

  test("checks a remote hub before changing collector state", async () => {
    const events: string[] = []
    const server = "https://hub.example.ts.net/"
    const url = await runSetup({ mode: "join", server, name: "Laptop" }, recordingActions(events))

    expect(url).toBe(server)
    expect(events).toEqual([
      `wait:${server}`,
      `configure:${server}:Laptop`,
      "collect",
      "install:collector:node",
    ])
  })

  test("leaves collector configuration untouched when the hub is unavailable", async () => {
    const events: string[] = []
    const server = "https://offline.example.ts.net/"

    await expect(
      runSetup({ mode: "join", server }, recordingActions(events, new Error("offline"))),
    ).rejects.toThrow("offline")
    expect(events).toEqual([`wait:${server}`])
  })
})
