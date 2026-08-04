import { afterEach, describe, expect, test } from "bun:test"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import {
  BootstrapV1Schema,
  SettingsPatchSchema,
  decodeExact,
  type BootstrapV1,
  type IngestRequestV1,
  type SettingsPatch,
} from "../shared/protocol"
import { App } from "../src/App"

const origin = "http://trails.test"
const fixedTimestamp = "2026-07-01T12:30:00.000Z"
const fixedNow = Date.parse(fixedTimestamp)
const originalFetch = globalThis.fetch
const databases = new Set<TrailsDb>()

const firstTrail: IngestRequestV1 = {
  protocolVersion: 1,
  device: { id: "source-mac", name: "Source Mac" },
  sessions: [
    {
      sourceSessionId: "first-trail",
      source: "omp",
      cwd: "/Users/tester/code/acme/trails",
      branch: "feat/onboarding",
      start: "2026-07-01T12:29:00.000Z",
      end: fixedTimestamp,
      events: 2,
      userEvents: 1,
      firstPrompt: "Make the first trail legible",
      activity: [["2026-07-01", 330, 2, 1]],
      digest: null,
    },
  ],
}

type Release = () => void

interface Harness {
  readonly bootstrap: () => Promise<BootstrapV1>
  readonly failNextSettingsPatch: (patch: SettingsPatch) => void
  readonly holdNextBootstrap: () => () => void
  readonly ingest: () => Promise<void>
  readonly serverRequest: (path: string, init?: RequestInit) => Promise<Response>
  readonly settingsRequests: SettingsPatch[]
}

// Cloudflare Worker globals widen Element away from the browser DOM type expected by user-event.
function userEventElement(element: unknown): Element {
  return element as Element
}

function selectElement(element: HTMLElement): HTMLSelectElement {
  if (!(element instanceof HTMLSelectElement)) throw new Error("expected a select element")
  return element
}

function makeHarness(): Harness {
  const db = openDatabase(":memory:")
  databases.add(db)
  const app = createApp({ db, now: () => fixedNow })
  const failedSettingsPatches: SettingsPatch[] = []
  const settingsRequests: SettingsPatch[] = []
  let heldBootstrap: Promise<void> | null = null
  let releaseBootstrap: Release | null = null

  async function serverRequest(path: string, init?: RequestInit): Promise<Response> {
    return app(new Request(new URL(path, origin), init))
  }

  async function bootstrap(): Promise<BootstrapV1> {
    const response = await serverRequest("/api/bootstrap", { headers: { Accept: "application/json" } })
    expect(response.status).toBe(200)
    return decodeExact(BootstrapV1Schema, await response.json())
  }

  async function ingest(): Promise<void> {
    const response = await serverRequest("/api/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(firstTrail),
    })
    expect(response.status).toBe(200)
  }

  function failNextSettingsPatch(patch: SettingsPatch): void {
    failedSettingsPatches.push(patch)
  }

  function holdNextBootstrap(): Release {
    if (heldBootstrap !== null) throw new Error("a bootstrap request is already held")
    heldBootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve
    })
    return () => {
      const release = releaseBootstrap
      releaseBootstrap = null
      heldBootstrap = null
      release?.()
    }
  }

  const routedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const path = input instanceof Request ? input.url : String(input)
    const request = new Request(new URL(path, origin), init)
    const url = new URL(request.url)

    if (url.pathname === "/api/settings" && request.method === "PATCH") {
      const patch = decodeExact(SettingsPatchSchema, await request.clone().json())
      settingsRequests.push(patch)
      const failureIndex = failedSettingsPatches.findIndex(
        (expected) => JSON.stringify(expected) === JSON.stringify(patch),
      )
      if (failureIndex >= 0) {
        failedSettingsPatches.splice(failureIndex, 1)
        return Response.json({ error: { message: "injected settings failure" } }, { status: 503 })
      }
    }

    if (url.pathname === "/api/bootstrap" && heldBootstrap !== null) await heldBootstrap
    return app(request)
  }, { preconnect: () => {} })

  globalThis.fetch = routedFetch

  return {
    bootstrap,
    failNextSettingsPatch,
    holdNextBootstrap,
    ingest,
    serverRequest,
    settingsRequests,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const database of databases) database.close()
  databases.clear()
})

async function expectCanonical(
  harness: Harness,
  expected: Partial<BootstrapV1["preferences"]>,
): Promise<void> {
  await waitFor(async () => {
    expect((await harness.bootstrap()).preferences).toMatchObject(expected)
  })
}

describe("first-run onboarding", () => {
  test("moves from a truthful empty Welcome into the first trail without completing on navigation", async () => {
    const harness = makeHarness()
    const user = userEvent.setup()
    render(<App />)

    expect(
      await screen.findByRole("heading", { name: "Trails hasn’t received a supported session yet" }),
    ).toBeTruthy()
    expect(
      screen.getByText(
        "Trails watches Claude Code, Codex, omp, and pi. New work normally appears here within one minute.",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText("Transcripts are parsed on the source Mac. Transcript bodies never reach the hub."),
    ).toBeTruthy()

    await user.tab()
    const checkAgain = screen.getByRole("button", { name: "check again" })
    expect(document.activeElement).toBe(checkAgain)
    const releaseCheck = harness.holdNextBootstrap()
    await user.click(checkAgain)
    const checking = screen.getByRole("button", { name: "checking…" }) as HTMLButtonElement
    expect(checking.disabled).toBe(true)
    expect(document.activeElement).toBe(checking)
    await act(async () => {
      releaseCheck()
      await Promise.resolve()
    })
    const waitingStatus = await screen.findByRole("status")
    expect(waitingStatus.textContent).toBe("Checked just now — still waiting for a supported session.")
    expect(document.activeElement).toBe(checkAgain)
    await user.click(screen.getByText("troubleshooting"))
    expect(screen.getByText("~/.local/bin/trails collect --once")).toBeTruthy()
    expect(
      screen.getByText(
        /If you haven’t used a supported agent yet, setup is complete — come back after your next session\.$/,
      ),
    ).toBeTruthy()

    await harness.ingest()
    await user.click(checkAgain)

    expect(await screen.findByRole("button", { name: "read my day" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "your first trail" })).toBeTruthy()
    expect(screen.getByText("Choose when late-night work becomes a new day.")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Trails hasn’t received a supported session yet" })).toBeNull()
    expect(
      screen.getByText(
        "nearby reading, reviewing, and thinking time counted around your prompts. The activity key below the timeline shows how your attention and agent runtime appear.",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        "Trails starts with one engagement per repository organization; an engagement can be a client, practice, or life area.",
      ),
    ).toBeTruthy()
    expect(screen.getByText("your attention")).toBeTruthy()
    expect(screen.getByText("agent runtime")).toBeTruthy()

    const week = screen.getByRole("button", { name: "week" })
    await user.click(week)
    expect(document.activeElement).toBe(week)
    expect(screen.queryByRole("button", { name: "read my day" })).toBeNull()

    const days = screen.getByRole("button", { name: "days" })
    await user.click(days)
    expect(document.activeElement).toBe(days)
    expect(screen.getByRole("button", { name: "read my day" })).toBeTruthy()
    expect((await harness.bootstrap()).preferences.onboardingVersion).toBe(0)
  })

  test("keeps settings and completion canonical across failures and the completion refresh", async () => {
    const harness = makeHarness()
    await harness.ingest()
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole("button", { name: "read my day" })).toBeTruthy()

    const boundary = selectElement(screen.getByRole("combobox", { name: "day starts" }))
    await user.selectOptions(userEventElement(boundary), "5")
    await expectCanonical(harness, { boundary: 5 })
    expect(boundary.value).toBe("5")

    const halo = selectElement(screen.getByRole("combobox", { name: "attention halo" }))
    harness.failNextSettingsPatch({ halo: 15 })
    await user.selectOptions(userEventElement(halo), "15")
    const settingAlert = await screen.findByRole("alert")
    expect(settingAlert.textContent).toBe("That setting didn’t save. Try again.")
    expect(Object.is(document.activeElement, halo)).toBe(true)
    expect((await harness.bootstrap()).preferences.halo).toBe(10)
    await waitFor(() => expect(halo.value).toBe("10"))

    await user.selectOptions(userEventElement(halo), "15")
    await expectCanonical(harness, { halo: 15 })
    expect(halo.value).toBe("15")
    await waitFor(() => expect(screen.queryByText("That setting didn’t save. Try again.")).toBeNull())

    harness.failNextSettingsPatch({ onboardingVersion: 1 })
    await user.click(screen.getByRole("button", { name: "read my day" }))
    const completionAlert = await screen.findByRole("alert")
    expect(completionAlert.textContent).toBe(
      "Trails couldn’t finish setup. Your day is still here; try again.",
    )
    expect(screen.getByRole("button", { name: "read my day" })).toBeTruthy()
    expect((await harness.bootstrap()).preferences.onboardingVersion).toBe(0)

    const releaseBootstrap = harness.holdNextBootstrap()
    await user.click(screen.getByRole("button", { name: "read my day" }))
    const opening = await screen.findByRole("button", { name: "opening your day…" })
    if (!(opening instanceof HTMLButtonElement)) throw new Error("expected a button")
    expect(opening.disabled).toBe(true)
    await expectCanonical(harness, { onboardingVersion: 1 })
    expect(screen.getByRole("button", { name: "organize projects first" })).toBeTruthy()
    expect(harness.settingsRequests.at(-1)).toEqual({ onboardingVersion: 1 })

    await act(async () => {
      releaseBootstrap()
      await Promise.resolve()
    })
    await waitFor(() => expect(screen.queryByRole("button", { name: "opening your day…" })).toBeNull())
    expect(screen.queryByRole("button", { name: "organize projects first" })).toBeNull()
    expect((await harness.bootstrap()).preferences).toMatchObject({
      boundary: 5,
      halo: 15,
      onboardingVersion: 1,
    })
  })

  test("uses server-owned onboarding version one on the initial load", async () => {
    const harness = makeHarness()
    await harness.ingest()
    const response = await harness.serverRequest("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingVersion: 1 }),
    })
    expect(response.status).toBe(200)
    expect((await harness.bootstrap()).preferences.onboardingVersion).toBe(1)

    render(<App />)

    expect(await screen.findByRole("button", { name: "settings" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "days" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "read my day" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "Trails hasn’t received a supported session yet" })).toBeNull()
    expect(screen.getByText("your attention")).toBeTruthy()
    expect(screen.getByText("agent runtime")).toBeTruthy()
  })
})
