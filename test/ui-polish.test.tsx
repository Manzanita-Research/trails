import { afterEach, describe, expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createApp } from "../server/app"
import type { HarnessControl } from "../server/harnesses/control"
import { openDatabase, type TrailsDb } from "../server/db"
import { DAY_SYSTEM, SESSION_SYSTEM } from "../shared/prompts"
import { HARNESS_IDS, HARNESSES, type HarnessId, type HarnessSelection } from "../shared/harnesses"
import { BootstrapV1Schema, decodeExact, type BootstrapV1, type IngestRequestV2 } from "../shared/protocol"
import { App } from "../src/App"

const origin = "http://trails.test"
const fixedNow = Date.parse("2026-07-01T19:30:00.000Z")
const activeProject = "code/acme/very-long-project-name"
const inertProject = "code/acme/inert-project"
const originalFetch = globalThis.fetch
const originalPrompt = window.prompt
const databases = new Set<TrailsDb>()

interface Harness {
  readonly bootstrap: () => Promise<BootstrapV1>
  readonly failNext: (path: string) => void
  readonly promptCalls: () => number
}

const sessions: IngestRequestV2 = {
  protocolVersion: 2,
  device: { id: "source-mac", name: "Source Mac" },
  sessions: [
    {
      sourceSessionId: "active-session",
      source: "omp",
      cwd: "/Users/tester/code/acme/very-long-project-name",
      branch: "feat/clarity",
      start: "2026-07-01T15:55:00.000Z",
      end: "2026-07-01T16:10:00.000Z",
      events: 8,
      userEvents: 4,
      firstPrompt: "Polish the beta journey",
      activity: [
        [Math.floor(Date.parse("2026-07-01T15:00:00.000Z") / 60_000), 2, 1],
        [Math.floor(Date.parse("2026-07-01T15:20:00.000Z") / 60_000), 2, 1],
        [Math.floor(Date.parse("2026-07-01T15:40:00.000Z") / 60_000), 2, 1],
        [Math.floor(Date.parse("2026-07-01T16:00:00.000Z") / 60_000), 2, 1],
      ],
      digest: null,
    },
    {
      sourceSessionId: "inert-session",
      source: "codex",
      cwd: "/Users/tester/code/acme/inert-project",
      branch: null,
      start: "2026-07-01T17:00:00.000Z",
      end: "2026-07-01T17:01:00.000Z",
      events: 2,
      userEvents: 0,
      firstPrompt: null,
      activity: [[Math.floor(Date.parse("2026-07-01T17:00:00.000Z") / 60_000), 2, 0]],
      digest: null,
    },
  ],
}

function userEventElement(element: unknown): Element {
  // Cloudflare Worker globals widen Element away from the browser DOM type expected by user-event.
  return element as Element
}


function inputElement(element: HTMLElement): HTMLInputElement {
  if (!(element instanceof HTMLInputElement)) throw new Error("expected an input element")
  return element
}


function harnessRuntime(enabled: boolean): {
  readonly control: HarnessControl
  readonly describe: () => { readonly selection: HarnessSelection; readonly harness: HarnessId } | null
} {
  const available: Record<HarnessId, boolean> = {
    omp: true,
    claude: false,
    codex: true,
    opencode: false,
    pi: false,
  }
  let selection: HarnessSelection | null = enabled ? "auto" : null
  const resolved = (): HarnessId | null =>
    selection === null ? null : selection === "auto" ? "omp" : available[selection] ? selection : null
  return {
    control: {
      status: () => ({
        protocolVersion: 1,
        harnesses: HARNESS_IDS.map((id) => ({
          id,
          label: HARNESSES[id].label,
          available: available[id],
        })),
        active: selection && {
          selection,
          harness: resolved(),
          state: "never_ran",
          lastAttemptAt: null,
          lastSuccessAt: null,
          lastErrorClass: null,
        },
      }),
      activate: (next) => {
        selection = next.harness
      },
      disconnect: () => {
        selection = null
      },
    },
    describe: () => {
      const harness = resolved()
      return selection !== null && harness !== null ? { selection, harness } : null
    },
  }
}

async function makeLoadedHarness({
  withDaySummary = true,
  summarization = "effective",
}: {
  withDaySummary?: boolean
  summarization?: "effective" | "disabled"
} = {}): Promise<Harness> {
  const harness = harnessRuntime(summarization === "effective")
  const db = openDatabase(":memory:", { defaultTimezone: "America/Los_Angeles" })
  databases.add(db)
  const app = createApp({
    db,
    now: () => fixedNow,
    harnesses: harness.control,
    summarization: { describe: harness.describe },
  })
  let failurePath: string | null = null
  let promptCount = 0
  const serverRequest = (path: string, init?: RequestInit) =>
    app(new Request(new URL(path, origin), init))

  let response = await serverRequest("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessions),
  })
  expect(response.status).toBe(200)
  response = await serverRequest("/api/collector-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: 1,
      device: sessions.device,
      outcome: {
        status: "processed",
        metrics: { discovered: 2, changed: 1, uploaded: 1, ignored: 0, unchanged: 1 },
        error: null,
      },
    }),
  })
  expect(response.status).toBe(204)
  if (withDaySummary) {
    db.sqlite
      .query(
        `INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("2026-07-01", activeProject, 6, "synthetic", "The active project gained a clear beta journey.", fixedNow)
  }
  response = await serverRequest("/api/settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ onboardingVersion: 1 }),
  })
  expect(response.status).toBe(200)
  response = await serverRequest("/api/pocket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Keep this note" }),
  })
  expect(response.status).toBe(201)

  async function bootstrap(): Promise<BootstrapV1> {
    const result = await serverRequest("/api/bootstrap")
    expect(result.status).toBe(200)
    return decodeExact(BootstrapV1Schema, await result.json())
  }

  const routedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), origin), init)
    const url = new URL(request.url)
    if (failurePath === url.pathname) {
      failurePath = null
      return Response.json({ error: { message: "injected request failure" } }, { status: 503 })
    }
    return app(request)
  }, { preconnect: () => {} })

  globalThis.fetch = routedFetch
  window.prompt = () => {
    promptCount++
    return null
  }

  return {
    bootstrap,
    failNext: (path) => {
      failurePath = path
    },
    promptCalls: () => promptCount,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  window.prompt = originalPrompt
  for (const database of databases) database.close()
  databases.clear()
  window.history.replaceState(null, "", "/")
})

describe("beta interaction clarity", () => {
  test("uses one recoverable settings screen for time, projects, machines, and summarization", async () => {
    const harness = await makeLoadedHarness()
    const user = userEvent.setup()
    render(<App />)

    expect(
      await screen.findByText(
        (_, element) =>
          element?.classList.contains("facts") === true && element.textContent?.includes("day credit: quarter") === true,
      ),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "organize projects" })).toBeNull()

    const settingsAction = screen.getByRole("button", { name: "settings" })
    await user.click(settingsAction)
    const settingsHeading = await screen.findByRole("heading", { name: "settings", level: 1 })
    expect(Object.is(document.activeElement, settingsHeading)).toBe(true)
    expect(settingsAction.getAttribute("aria-current")).toBe("page")
    expect(screen.queryByRole("dialog", { name: "settings" })).toBeNull()
    const settingsPage = settingsHeading.closest(".settings-view")
    if (!(settingsPage instanceof HTMLElement)) throw new Error("expected settings view")
    expect(
      within(settingsPage).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["time & attention", "projects", "machines", "summarization"])

    const boundary = within(settingsPage).getByRole("combobox", { name: "day starts" })
    await user.selectOptions(userEventElement(boundary), "5")
    await waitFor(async () => expect((await harness.bootstrap()).preferences.boundary).toBe(5))

    const halo = within(settingsPage).getByRole("combobox", { name: "attention halo" })
    harness.failNext("/api/settings")
    await user.selectOptions(userEventElement(halo), "15")
    const haloRow = halo.closest(".settings-control-row")
    if (!(haloRow instanceof HTMLElement)) throw new Error("expected halo row")
    expect(await within(haloRow).findByRole("alert")).toHaveTextContent("That setting didn’t save. Try again.")
    expect(boundary).not.toBeDisabled()
    await user.selectOptions(userEventElement(halo), "15")
    await waitFor(async () => expect((await harness.bootstrap()).preferences.halo).toBe(15))

    const timezone = within(settingsPage).getByRole("combobox", { name: "time zone" })
    expect(within(timezone).getByRole("option", { name: "Rome" })).toHaveValue("Europe/Rome")
    await user.selectOptions(userEventElement(timezone), "Europe/Rome")
    await waitFor(async () => expect((await harness.bootstrap()).timezone).toBe("Europe/Rome"))

    expect(await within(settingsPage).findByText("checked 0m ago")).toBeTruthy()
    expect(within(settingsPage).getByText("processed 0m ago")).toBeTruthy()
    expect(within(settingsPage).getByText("activity sent 0m ago")).toBeTruthy()
    expect(within(settingsPage).getByText("2 found · 1 changed · 1 sent · 0 ignored · 1 unchanged")).toBeTruthy()
    expect(within(settingsPage).queryByText(/online|offline/i)).toBeNull()
    expect(await within(settingsPage).findByText("using Oh My Pi")).toBeTruthy()
    expect(within(settingsPage).getByText(SESSION_SYSTEM)).toBeTruthy()
    expect(within(settingsPage).getByText(DAY_SYSTEM)).toBeTruthy()
    expect(
      within(settingsPage).getByText("A one-session day summary may be copied without a second harness call."),
    ).toBeTruthy()

    const engagementName = "engagement for very-long-project-name"
    await user.selectOptions(
      userEventElement(within(settingsPage).getByRole("combobox", { name: engagementName })),
      "__new__",
    )
    const engagementInput = inputElement(within(settingsPage).getByRole("textbox", { name: engagementName }))
    await user.click(within(settingsPage).getByRole("button", { name: "save" }))
    expect((await within(settingsPage).findByRole("alert")).textContent).toBe("Enter an engagement name.")
    await user.type(engagementInput, "Practice")
    harness.failNext("/api/engagements")
    await user.click(within(settingsPage).getByRole("button", { name: "save" }))
    expect((await within(settingsPage).findByRole("alert")).textContent).toBe(
      "Couldn’t save that engagement. Try again.",
    )
    await user.click(within(settingsPage).getByRole("button", { name: "save" }))
    await waitFor(async () => {
      const bootstrap = await harness.bootstrap()
      const practice = bootstrap.preferences.customEngagements.find(({ name }) => name === "Practice")
      if (!practice) throw new Error("expected saved engagement")
      expect(bootstrap.preferences.assignments[activeProject]).toBe(practice.id)
    })

    await user.click(within(settingsPage).getByRole("button", { name: "very-long-project-name" }))
    expect(await screen.findByRole("button", { name: "← back to settings" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "← back to settings" }))
    expect(await screen.findByRole("heading", { name: "settings", level: 1 })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "← back" }))
    expect(await screen.findByRole("heading", { name: "Wednesday, July 1" })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "threads" }))
    expect(screen.getByRole("button", { name: "delete note" })).toBeTruthy()
    expect(harness.promptCalls()).toBe(0)
  })

  test("keeps machine and summarization failures isolated and retryable", async () => {
    const harness = await makeLoadedHarness()
    const user = userEvent.setup()
    harness.failNext("/api/machines")
    render(<App />)

    await user.click(await screen.findByRole("button", { name: "settings" }))
    const machineHeading = await screen.findByRole("heading", { name: "machines", level: 2 })
    const machineSection = machineHeading.closest("section")
    if (!(machineSection instanceof HTMLElement)) throw new Error("expected machines section")
    expect(await within(machineSection).findByText(/Machine status couldn’t load/)).toBeTruthy()
    expect(await screen.findByText("using Oh My Pi")).toBeTruthy()
    await user.click(within(machineSection).getByRole("button", { name: "try again" }))
    expect(await within(machineSection).findByText("Source Mac")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "← back" }))
    harness.failNext("/api/summarization")
    await user.click(screen.getByRole("button", { name: "settings" }))
    const summaryHeading = await screen.findByRole("heading", { name: "summarization", level: 2 })
    const summarySection = summaryHeading.closest("section")
    if (!(summarySection instanceof HTMLElement)) throw new Error("expected summarization section")
    expect(await within(summarySection).findByText(/Summarization settings couldn’t load/)).toBeTruthy()
    expect(await screen.findByText("Source Mac")).toBeTruthy()
    await user.click(within(summarySection).getByRole("button", { name: "try again" }))
    expect(await within(summarySection).findByText("using Oh My Pi")).toBeTruthy()
  })

  test("renders the truthful disabled summarization state", async () => {
    await makeLoadedHarness({ summarization: "disabled" })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole("button", { name: "settings" }))
    expect(await screen.findByText("Summaries are off. Existing and queued timeline work stays local.")).toBeTruthy()
  })

  test("requires consent before switching harnesses without handling their credentials", async () => {
    await makeLoadedHarness()
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole("button", { name: "settings" }))
    const summaryHeading = await screen.findByRole("heading", { name: "summarization", level: 2 })
    const summarySection = summaryHeading.closest("section")
    if (!(summarySection instanceof HTMLElement)) throw new Error("expected summarization section")

    expect(within(summarySection).getByText(/never reads or copies its credentials/)).toBeTruthy()
    const automaticRow = within(summarySection).getByRole("heading", { name: "Automatic" }).closest("article")
    if (!(automaticRow instanceof HTMLElement)) throw new Error("expected automatic harness row")
    expect(within(automaticRow).getByText("in use")).toBeTruthy()

    await user.click(within(summarySection).getByRole("button", { name: "use Codex" }))
    const consent = await within(summarySection).findByRole("alertdialog")
    expect(consent.textContent).toContain("invoke Codex")
    expect(consent.textContent).toContain("provider that harness already uses")
    await user.click(within(consent).getByRole("button", { name: "cancel" }))
    expect(within(automaticRow).getByText("in use")).toBeTruthy()

    await user.click(within(summarySection).getByRole("button", { name: "use Codex" }))
    await user.click(within(await within(summarySection).findByRole("alertdialog")).getByRole("button", { name: "confirm and use" }))
    expect(await within(summarySection).findByText("Codex will summarize new and queued digests.")).toBeTruthy()
    const codexRow = within(summarySection).getByRole("heading", { name: "Codex" }).closest("article")
    if (!(codexRow instanceof HTMLElement)) throw new Error("expected Codex harness row")
    expect(within(codexRow).getByText("in use")).toBeTruthy()
  })

  test("shows a truthful hub failure without inventing a network diagnosis", async () => {
    globalThis.fetch = Object.assign(async () => new Response("not json", { status: 500 }), { preconnect: () => {} })
    render(<App />)

    expect(await screen.findByRole("heading", { name: "Trails couldn’t load the hub." })).toBeTruthy()
    expect(screen.getByRole("link", { name: "http://127.0.0.1:7412/" })).toBeTruthy()
    expect(screen.getByText("On multiple Macs, use the private URL printed by setup.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "retry" })).toBeTruthy()
    expect(screen.getByText("technical detail")).toBeTruthy()
    expect(screen.getByText("request failed (500)")).toBeTruthy()
    expect(screen.queryByText(/unreachable/i)).toBeNull()
  })

  test("explains when indexed activity is waiting for summaries", async () => {
    await makeLoadedHarness({ withDaySummary: false })
    render(<App />)

    expect(await screen.findByText("Project summaries haven’t arrived yet.")).toBeTruthy()
    expect(
      screen.getByText("Your indexed activity is already visible above. Summaries will appear here when they’re ready."),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: /jump to day summary/ })).toBeNull()
  })

  test("keeps all timeline geometry and full accessible labels inside 390 pixels", async () => {
    const harness = await makeLoadedHarness()
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth")
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 390 })
    try {
      render(<App />)
      const timeline = await screen.findByRole("group", { name: "activity timeline" })
      expect(timeline.getAttribute("width")).toBe("390")
      expect(timeline.getAttribute("viewBox")?.startsWith("0 0 390 ")).toBe(true)
      expect(screen.getByText("very-long-pro…")).toBeTruthy()
      expect(
        screen.getByRole("button", {
          name: /very-long-project-name; activity from .*; jump to day summary\./,
        }),
      ).toBeTruthy()
      for (const element of timeline.querySelectorAll("line, rect, text")) {
        const x = Number(element.getAttribute("x") ?? element.getAttribute("x1") ?? 0)
        const width = Number(element.getAttribute("width") ?? 0)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x + width).toBeLessThanOrEqual(390)
      }
      expect((await harness.bootstrap()).preferences.onboardingVersion).toBe(1)
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "clientWidth", descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth")
    }
  })
})
