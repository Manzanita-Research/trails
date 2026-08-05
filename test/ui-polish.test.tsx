import { afterEach, describe, expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { createApp } from "../server/app"
import { openDatabase, type TrailsDb } from "../server/db"
import {
  BootstrapV1Schema,
  decodeExact,
  type BootstrapV1,
  type IngestCapturesRequestV1,
  type IngestRequestV2,
} from "../shared/protocol"
import { App } from "../src/App"
import { attentionMinutes, buildDays, CREATIVE_ELSEWHERE_PROJECT } from "../src/lib/data"

const origin = "http://trails.test"
const fixedNow = Date.parse("2026-07-01T19:30:00.000Z")
const activeProject = "code/acme/very-long-project-name"
const inertProject = "code/acme/inert-project"
const originalFetch = globalThis.fetch
const originalPrompt = window.prompt
const originalScrollTo = globalThis.scrollTo
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
const captureBytes = Buffer.from("RIFF\x08\x00\x00\x00WEBPsynthetic").toString("base64")
function pacificUtcMinute(date: string, minute: number): number {
  const hour = String(Math.floor(minute / 60)).padStart(2, "0")
  const minuteOfHour = String(minute % 60).padStart(2, "0")
  return Math.floor(Date.parse(`${date}T${hour}:${minuteOfHour}:00-07:00`) / 60_000)
}
const captures: IngestCapturesRequestV1 = {
  protocolVersion: 1,
  device: { id: "source-mac", name: "Source Mac" },
  captures: [
    {
      source: "midjourney",
      sourceRecordId: "generation-parent",
      project: null,
      projectHint: "Active project",
      title: "Forest study",
      startedAt: "2026-07-01T16:30:00.000Z",
      endedAt: null,
      summaryInput: "A mossy trail through redwoods",
      attentionMinutes: [pacificUtcMinute("2026-07-01", 510)],
      payload: {
        eventType: "imagine",
        jobType: "generation",
        parentSourceRecordId: null,
        parentGrid: null,
      },
      images: Array.from({ length: 4 }, (_, index) => ({
        index,
        mime: "image/webp" as const,
        width: 640,
        height: 640,
        bytes: captureBytes,
      })),
    },
    {
      source: "midjourney",
      sourceRecordId: "generation-child",
      project: "/Users/tester/code/acme/very-long-project-name",
      projectHint: "Active project",
      title: "Forest study variation",
      startedAt: "2026-07-01T16:50:00.000Z",
      endedAt: null,
      summaryInput: "The same trail at blue hour",
      attentionMinutes: [pacificUtcMinute("2026-07-01", 530)],
      payload: {
        eventType: "variation",
        jobType: "generation",
        parentSourceRecordId: "generation-parent",
        parentGrid: 1,
      },
      images: Array.from({ length: 4 }, (_, index) => ({
        index,
        mime: "image/webp" as const,
        width: 640,
        height: 640,
        bytes: captureBytes,
      })),
    },
    {
      source: "midjourney",
      sourceRecordId: "generation-orphan",
      project: "/Users/tester/code/acme/very-long-project-name",
      projectHint: "Active project",
      title: "Earlier variation",
      startedAt: "2026-07-01T17:10:00.000Z",
      endedAt: null,
      summaryInput: "A variation whose parent belongs to an earlier day",
      attentionMinutes: [pacificUtcMinute("2026-07-01", 550)],
      payload: {
        eventType: "variation",
        jobType: "generation",
        parentSourceRecordId: "generation-from-earlier-work",
        parentGrid: 2,
      },
      images: Array.from({ length: 4 }, (_, index) => ({
        index,
        mime: "image/webp" as const,
        width: 640,
        height: 640,
        bytes: captureBytes,
      })),
    },
    {
      source: "granola",
      sourceRecordId: "meeting-unassigned",
      project: null,
      projectHint: "Studio",
      title: "Creative review",
      startedAt: "2026-07-01T17:30:00.000Z",
      endedAt: "2026-07-01T18:00:00.000Z",
      summaryInput: "Reviewed the current visual direction and chose the quieter composition.",
      attentionMinutes: Array.from({ length: 30 }, (_, index) => pacificUtcMinute("2026-07-01", 570 + index)),
      payload: {
        attendeeCount: 3,
      },
      images: [],
    },
    {
      source: "granola",
      sourceRecordId: "meeting-point",
      project: null,
      projectHint: "Studio",
      title: "Quick note",
      startedAt: "2026-07-01T18:10:00.000Z",
      endedAt: null,
      summaryInput: "Captured one exact point without inventing a scheduled interval.",
      attentionMinutes: [pacificUtcMinute("2026-07-01", 610)],
      payload: {
        attendeeCount: 0,
      },
      images: [],
    },
    {
      source: "granola",
      sourceRecordId: "prior-project-note",
      project: "/Users/tester/code/acme/very-long-project-name",
      projectHint: "Active project",
      title: "Prior project note",
      startedAt: "2026-06-30T18:10:00.000Z",
      endedAt: null,
      summaryInput: "A capture-only project day remains connected to its existing project.",
      attentionMinutes: [pacificUtcMinute("2026-06-30", 610)],
      payload: {
        attendeeCount: 0,
      },
      images: [],
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


async function makeLoadedHarness({
  withDaySummary = true,
  summarization = "effective",
}: {
  withDaySummary?: boolean
  summarization?: "effective" | "disabled"
} = {}): Promise<Harness> {
  const db = openDatabase(":memory:", { defaultTimezone: "America/Los_Angeles" })
  databases.add(db)
  const metadata = {
    protocolVersion: 1 as const,
    model: "@cf/moonshotai/kimi-k2.5",
    prompts: { session: "Complete session system prompt.", day: "Complete day system prompt." },
  }
  const app = createApp({
    db,
    now: () => fixedNow,
    inference:
      summarization === "effective"
        ? { url: "https://relay.test/api/summarize", token: "relay-token" }
        : undefined,
    fetch: (async () => Response.json(metadata)) as unknown as typeof globalThis.fetch,
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
  response = await serverRequest("/api/captures", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(captures),
  })
  if (response.status !== 200) throw new Error(await response.text())
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
  globalThis.scrollTo = originalScrollTo

  globalThis.fetch = originalFetch
  window.prompt = originalPrompt
  for (const database of databases) database.close()
  databases.clear()
})
describe("ambient day-weave arithmetic", () => {
  test("discovers capture-only days and folds exact capture minutes at the workday boundary", () => {
    const captureRows: BootstrapV1["captures"] = [
      {
        id: "capture-before-boundary",
        source: "granola",
        project: null,
        projectHint: "Studio",
        title: "Early review",
        startedAt: "2026-07-02T05:00:00.000Z",
        endedAt: null,
        summaryInput: "A bounded note",
        attentionMinutes: [["2026-07-02", 300]],
        updatedAt: "2026-07-02T05:00:00.000Z",
        payload: { attendeeCount: 1 },
        images: [],
      },
      {
        id: "capture-after-boundary",
        source: "midjourney",
        project: "code/acme/art",
        projectHint: "Art",
        title: "Morning study",
        startedAt: "2026-07-02T10:00:00.000Z",
        endedAt: null,
        summaryInput: "A bounded prompt",
        attentionMinutes: [["2026-07-02", 600]],
        updatedAt: "2026-07-02T10:00:00.000Z",
        payload: {
          eventType: "imagine",
          jobType: "generation",
          parentGrid: null,
          hasParent: false,
          parentCaptureId: null,
        },
        images: [],
      },
    ]

    const days = buildDays([], captureRows, 6)
    expect(days.map(([date]) => date)).toEqual(["2026-07-02", "2026-07-01"])
    expect(days[0]![1].get("code/acme/art")?.midjourney).toEqual(new Set([600]))
    expect(days[1]![1].get(CREATIVE_ELSEWHERE_PROJECT)?.granola).toEqual(new Set([1740]))
    expect(days[1]![1].get(CREATIVE_ELSEWHERE_PROJECT)?.sessions.size).toBe(0)
  })

  test("unions source attention once while applying halo only to coding", () => {
    expect(attentionMinutes([new Set([100, 120])], [new Set([110, 111, 140])], 10)).toBe(42)
    expect(attentionMinutes([new Set([100])], [new Set([100])], 0)).toBe(1)
    expect(attentionMinutes([], [new Set([200, 201])], 15)).toBe(2)
  })
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
    expect(
      screen.getByRole("button", {
        name: /very-long-project-name; activity from .*; jump to day story\./,
      }),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: /inert-project; activity from .*; jump to day story\./ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /creative elsewhere; activity from .*; jump to day story\./ })).toBeTruthy()

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
    expect(await within(settingsPage).findByText("@cf/moonshotai/kimi-k2.5")).toBeTruthy()
    expect(within(settingsPage).getByText("Complete session system prompt.")).toBeTruthy()
    expect(within(settingsPage).getByText("Complete day system prompt.")).toBeTruthy()
    expect(
      within(settingsPage).getByText("A one-session day summary may be copied without a second model call."),
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
    expect(await screen.findByText("@cf/moonshotai/kimi-k2.5")).toBeTruthy()
    await user.click(within(machineSection).getByRole("button", { name: "try again" }))
    expect(await within(machineSection).findByText("Source Mac")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "← back" }))
    harness.failNext("/api/summarization")
    await user.click(screen.getByRole("button", { name: "settings" }))
    const summaryHeading = await screen.findByRole("heading", { name: "summarization", level: 2 })
    const summarySection = summaryHeading.closest("section")
    if (!(summarySection instanceof HTMLElement)) throw new Error("expected summarization section")
    expect(await within(summarySection).findByText(/Summarization details couldn’t load/)).toBeTruthy()
    expect(await screen.findByText("Source Mac")).toBeTruthy()
    await user.click(within(summarySection).getByRole("button", { name: "try again" }))
    expect(await within(summarySection).findByText("@cf/moonshotai/kimi-k2.5")).toBeTruthy()
  })

  test("renders the truthful disabled summarization state", async () => {
    await makeLoadedHarness({ summarization: "disabled" })
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole("button", { name: "settings" }))
    expect(await screen.findByText("Summarization is off on this hub.")).toBeTruthy()
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

  test("weaves capture evidence through day, week, and existing project views", async () => {
    await makeLoadedHarness()
    const user = userEvent.setup()
    render(<App />)

    const timeline = await screen.findByRole("group", { name: "activity timeline" })
    const dayFacts = screen.getAllByText((_, element) => element?.classList.contains("facts") === true)[0]!
    expect(dayFacts.textContent).toContain("attention 1h 52m")
    expect(timeline.querySelectorAll('[data-kind="meeting"]')).toHaveLength(2)
    expect(timeline.querySelectorAll('[data-kind="image"]')).toHaveLength(3)
    const meetingMark = timeline.querySelector('[data-kind="meeting"]')
    if (!(meetingMark instanceof SVGElement)) throw new Error("expected a meeting mark")
    await user.hover(userEventElement(meetingMark))
    expect(await screen.findByText(/meeting · 9:30 am–10:00 am/)).toBeTruthy()

    const creativeLane = screen.getByRole("button", { name: /creative elsewhere; activity from/ })
    const scrollCalls: unknown[][] = []
    globalThis.scrollTo = ((...args: unknown[]) => scrollCalls.push(args)) as typeof scrollTo
    await user.click(userEventElement(creativeLane))
    expect(scrollCalls.length).toBeGreaterThan(0)
    scrollCalls.length = 0
    creativeLane.focus()
    await user.keyboard("{Enter}")
    expect(scrollCalls.length).toBeGreaterThan(0)

    const images = screen.getAllByRole("img", { name: /Forest study, image/ })
    expect(images).toHaveLength(4)
    expect(images.every((image) => image.getAttribute("loading") === "lazy")).toBe(true)
    const parentCard = screen.getByRole("heading", { name: "Forest study" }).closest("article")
    if (!(parentCard instanceof HTMLElement)) throw new Error("expected the parent capture card")
    const originalScrollIntoView = Element.prototype.scrollIntoView
    let lineageTarget: string | null = null
    Element.prototype.scrollIntoView = function () {
      lineageTarget = this.id
    }
    try {
      await user.click(screen.getByRole("button", { name: "view parent generation" }))
      expect(lineageTarget === parentCard.id).toBe(true)
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
    expect(screen.queryByRole("link", { name: "open in Granola" })).toBeNull()
    expect(screen.getByText("variation from earlier work")).toBeTruthy()
    expect(screen.getByText("10:10 · 0 attendees")).toBeTruthy()
    const creativeElsewhere = document.querySelector(".proj-cap-static")
    if (!(creativeElsewhere instanceof HTMLElement)) throw new Error("expected the capture-only project label")
    expect(creativeElsewhere.classList.contains("proj-cap-static")).toBe(true)
    expect(screen.queryByRole("button", { name: "creative elsewhere" })).toBeNull()

    await user.keyboard("{ArrowLeft}")
    expect(await screen.findByRole("heading", { name: "Tuesday, June 30" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "very-long-project-name" })).toBeTruthy()
    await user.keyboard("{ArrowRight}")
    expect(await screen.findByRole("heading", { name: "Wednesday, July 1" })).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "week" }))
    const weekFacts = (await screen.findAllByText((_, element) => element?.classList.contains("facts") === true))[0]!
    expect(weekFacts.textContent).toContain("attention 1h 53m")
    expect([...document.querySelectorAll(".wk-eng .name")].map((element) => element.textContent)).toContain("elsewhere")
    expect([...document.querySelectorAll(".wk-eng")].map((element) => element.textContent)).toContain("elsewhere32m")

    await user.click(screen.getByRole("button", { name: "days" }))
    await user.click(screen.getByRole("button", { name: "very-long-project-name" }))
    expect(await screen.findByRole("heading", { name: "very-long-project-name" })).toBeTruthy()
    const projectFacts = screen.getAllByText((_, element) => element?.classList.contains("facts") === true)[0]!
    expect(projectFacts.textContent).toContain("attention 1h 22m")
    expect(document.querySelectorAll('.detail-strip [data-kind="image"]')).toHaveLength(2)
  })

  test("keeps ambient evidence visible while coding summaries are pending", async () => {
    await makeLoadedHarness({ withDaySummary: false })
    render(<App />)

    expect(
      (await screen.findAllByText("Coding activity is visible above. Its project summary hasn’t arrived yet.")).length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Creative review")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: /jump to day story/ }).length).toBeGreaterThanOrEqual(1)
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
          name: /very-long-project-name; activity from .*; jump to day story\./,
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
