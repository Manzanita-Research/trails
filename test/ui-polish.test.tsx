import { afterEach, describe, expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import { BootstrapV1Schema, decodeExact, type BootstrapV1, type IngestRequestV1 } from "../shared/protocol"
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

const sessions: IngestRequestV1 = {
  protocolVersion: 1,
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
        ["2026-07-01", 480, 2, 1],
        ["2026-07-01", 500, 2, 1],
        ["2026-07-01", 520, 2, 1],
        ["2026-07-01", 540, 2, 1],
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
      activity: [["2026-07-01", 600, 2, 0]],
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


async function makeLoadedHarness(): Promise<Harness> {
  const db = openDatabase(":memory:")
  databases.add(db)
  const app = createApp({ db, now: () => fixedNow })
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
  db.sqlite
    .query(
      `INSERT INTO day_summaries(work_date, project, boundary, model, summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run("2026-07-01", activeProject, 6, "synthetic", "The active project gained a clear beta journey.", fixedNow)
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
})

describe("beta interaction clarity", () => {
  test("uses recoverable inline organization and project tools with accessible panels", async () => {
    const harness = await makeLoadedHarness()
    const user = userEvent.setup()
    render(<App />)

    expect(
      await screen.findByText(
        (_, element) =>
          element?.classList.contains("facts") === true && element.textContent?.includes("day credit: quarter") === true,
      ),
    ).toBeTruthy()
    expect(
      screen.getByRole("button", {
        name: /very-long-project-name; activity from .*; jump to day summary\./,
      }),
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: /inert-project; activity from/ })).toBeNull()

    const organize = screen.getByRole("button", { name: "organize projects" })
    await user.click(organize)
    const panel = await screen.findByRole("dialog", { name: "Organize projects" })
    if (!(panel instanceof HTMLDialogElement)) throw new Error("expected a dialog")
    expect(organize.getAttribute("aria-expanded")).toBe("true")
    expect(organize.getAttribute("aria-controls")).toBe("organize-projects-panel")
    expect(within(panel).getByRole("button", { name: "close Organize projects" })).toBeTruthy()
    expect(
      within(panel).getByText(
        "Trails starts with one engagement per repository organization. An engagement can be a client, a practice, or a life area; changing one updates week totals.",
      ),
    ).toBeTruthy()

    const engagementName = "engagement for very-long-project-name"
    await user.selectOptions(
      userEventElement(within(panel).getByRole("combobox", { name: engagementName })),
      "__new__",
    )
    const engagementInput = inputElement(within(panel).getByRole("textbox", { name: engagementName }))
    await user.click(within(panel).getByRole("button", { name: "save" }))
    expect((await within(panel).findByRole("alert")).textContent).toBe("Enter an engagement name.")

    await user.type(engagementInput, "Practice")
    harness.failNext("/api/engagements")
    await user.click(within(panel).getByRole("button", { name: "save" }))
    expect((await within(panel).findByRole("alert")).textContent).toBe(
      "Couldn’t save that engagement. Try again.",
    )
    expect(engagementInput.value).toBe("Practice")
    expect(Object.is(document.activeElement, engagementInput)).toBe(true)

    await user.click(within(panel).getByRole("button", { name: "save" }))
    await waitFor(async () => {
      const bootstrap = await harness.bootstrap()
      const practice = bootstrap.preferences.customEngagements.find(({ name }) => name === "Practice")
      if (!practice) throw new Error("expected the saved engagement")
      expect(bootstrap.preferences.assignments[activeProject] === practice.id).toBe(true)
    })
    expect(within(panel).getByRole("combobox", { name: engagementName })).toBeTruthy()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(panel.open).toBe(false))
    expect(Object.is(document.activeElement, organize)).toBe(true)

    await user.click(organize)
    const reopened = await screen.findByRole("dialog", { name: "Organize projects" })
    await user.click(within(reopened).getByRole("button", { name: "very-long-project-name" }))
    expect(await screen.findByRole("button", { name: "← back to days" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "rename" }))
    const renameInput = inputElement(screen.getByRole("textbox", { name: "project name" }))
    expect(renameInput.value).toBe("very-long-project-name")
    expect(Object.is(document.activeElement, renameInput)).toBe(true)
    await user.clear(renameInput)
    await user.type(renameInput, "Trail Journal")
    harness.failNext("/api/projects")
    await user.click(screen.getByRole("button", { name: "save" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Couldn’t rename this project. Try again.")
    expect(renameInput.value).toBe("Trail Journal")
    expect(Object.is(document.activeElement, renameInput)).toBe(true)

    await user.click(screen.getByRole("button", { name: "save" }))
    await waitFor(async () => {
      expect((await harness.bootstrap()).preferences.names[activeProject]).toBe("Trail Journal")
    })
    expect(await screen.findByRole("heading", { name: "Trail Journal" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "rename" }))
    const resetInput = inputElement(screen.getByRole("textbox", { name: "project name" }))
    await user.clear(resetInput)
    await user.click(screen.getByRole("button", { name: "save" }))
    await waitFor(async () => {
      expect(activeProject in (await harness.bootstrap()).preferences.names).toBe(false)
    })
    expect(await screen.findByRole("heading", { name: "very-long-project-name" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "← back to days" }))
    const settings = screen.getByRole("button", { name: "settings" })
    await user.click(settings)
    expect(await screen.findByRole("dialog", { name: "settings" })).toBeTruthy()
    expect(Object.is(document.activeElement, screen.getByRole("combobox", { name: "day starts" }))).toBe(true)
    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "settings" })).toBeNull())
    expect(Object.is(document.activeElement, settings)).toBe(true)

    await user.click(screen.getByRole("button", { name: "threads" }))
    expect(screen.getByRole("button", { name: "delete note" })).toBeTruthy()
    expect(harness.promptCalls()).toBe(0)
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
