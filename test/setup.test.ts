import { describe, expect, test } from "bun:test"
import { runSetup, type SetupActions } from "../cli/setup"

function recordingActions(events: string[], waitFailure?: Error): SetupActions {
  return {
    configureCollector: (server, name) => events.push(`configure:${server}:${name ?? "default"}`),
    install: async (kind) => { events.push(`install:${kind}`) },
    collect: async () => { events.push("collect") },
    waitForServer: async (server) => {
      events.push(`wait:${server}`)
      if (waitFailure) throw waitFailure
    },
    tailnetUrl: () => {
      events.push("tailnet-url")
      return "https://mini.example.ts.net/"
    },
  }
}

describe("one-command setup", () => {
  test("starts a hub before indexing and scheduling its collector", async () => {
    const events: string[] = []
    const url = await runSetup({ mode: "hub", name: "Studio Mini" }, recordingActions(events))

    expect(url).toBe("https://mini.example.ts.net/")
    expect(events).toEqual([
      "configure:http://127.0.0.1:7412/:Studio Mini",
      "install:server",
      "wait:http://127.0.0.1:7412/",
      "collect",
      "install:collector",
      "tailnet-url",
    ])
  })

  test("checks a remote hub before changing collector state", async () => {
    const events: string[] = []
    const server = "https://mini.example.ts.net/"
    const url = await runSetup({ mode: "join", server, name: "Laptop" }, recordingActions(events))

    expect(url).toBe(server)
    expect(events).toEqual([
      `wait:${server}`,
      `configure:${server}:Laptop`,
      "collect",
      "install:collector",
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
