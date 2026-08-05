import { afterEach, describe, expect, test } from "bun:test"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent, { type UserEvent } from "@testing-library/user-event"
import { useRef, useState } from "react"
import {
  FeedbackSubmissionV1Schema,
  decodeExact,
  type FeedbackSubmissionV1,
} from "../shared/protocol"
import { App } from "../src/App"
import { FeedbackPanel } from "../src/components/FeedbackPanel"
import {
  buildFeedbackSafeContext,
  type FeedbackSafeContextInput,
} from "../src/lib/feedback"

const endpoint = "https://feedback.test/api/feedback"
const originalFetch = globalThis.fetch
const originalClipboardWriteText = Object.getOwnPropertyDescriptor(navigator.clipboard, "writeText")

const contextInput: FeedbackSafeContextInput = {
  appVersion: "0.1.0-beta.1",
  view: "days",
  bootstrap: {
    revision: 7,
    sessions: [{ source: "claude" }, { source: "claude" }, { source: "pi" }],
  },
  workDate: "2026-07-31",
  viewport: { width: 390, height: 844 },
  syncError: false,
}

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator.clipboard, "writeText", {
    configurable: true,
    value: writeText,
  })
}

function setFetch(handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, { preconnect: () => {} }) as typeof fetch
}

function PanelHarness({
  safeContext = contextInput,
}: {
  readonly safeContext?: FeedbackSafeContextInput
}) {
  const [open, setOpen] = useState(true)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
        feedback
      </button>
      <FeedbackPanel
        id="feedback-panel"
        open={open}
        onClose={() => setOpen(false)}
        fallbackFocusRef={triggerRef}
        endpoint={endpoint}
        contextInput={safeContext}
      />
    </>
  )
}

function feedbackBody(panel: HTMLElement): string {
  const payload = within(panel).getByRole("document", { name: "feedback request body" })
  return payload.textContent ?? ""
}
function decodedFeedback(body: string): FeedbackSubmissionV1 {
  return decodeExact(FeedbackSubmissionV1Schema, JSON.parse(body))
}


async function prepareFeedback(
  user: UserEvent,
  panel: HTMLElement,
  options: { kind?: "confusing" | "broken" | "idea" | "delight"; message?: string; followUp?: string } = {},
): Promise<string> {
  await user.selectOptions(
    within(panel).getByRole("combobox", { name: "kind" }),
    options.kind ?? "confusing",
  )
  await user.type(
    within(panel).getByRole("textbox", { name: "what happened?" }),
    options.message ?? "The trail changed under me.",
  )
  if (options.followUp !== undefined) {
    await user.type(
      within(panel).getByRole("textbox", { name: "follow-up details (optional)" }),
      options.followUp,
    )
  }
  await user.click(within(panel).getByRole("button", { name: "preview feedback" }))
  await waitFor(() => expect(within(panel).getByRole("heading", { name: "preview" })).toHaveFocus())
  return feedbackBody(panel)
}

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalClipboardWriteText === undefined) Reflect.deleteProperty(navigator.clipboard, "writeText")
  else Object.defineProperty(navigator.clipboard, "writeText", originalClipboardWriteText)
  window.getSelection()?.removeAllRanges()
})

describe("safe feedback context", () => {
  test("counts only supported sources and makes unavailable and loaded-empty snapshots distinct", () => {
    expect(buildFeedbackSafeContext(contextInput)).toEqual({
      appVersion: "0.1.0-beta.1",
      view: "days",
      revision: 7,
      workDate: "2026-07-31",
      sourceCounts: { claude: 2, codex: 0, omp: 0, pi: 1 },
      viewport: { width: 390, height: 844 },
      syncError: false,
    })

    expect(
      buildFeedbackSafeContext({
        appVersion: "0.1.0-beta.1",
        view: "hub-error",
        bootstrap: null,
        workDate: "2026-07-31",
        viewport: { width: 0.6, height: 10_001 },
        syncError: true,
      }),
    ).toEqual({
      appVersion: "0.1.0-beta.1",
      view: "hub-error",
      revision: null,
      workDate: null,
      sourceCounts: null,
      viewport: { width: 1, height: 10_000 },
      syncError: true,
    })

    expect(
      buildFeedbackSafeContext({
        ...contextInput,
        bootstrap: { revision: 0, sessions: [] },
      }).sourceCounts,
    ).toEqual({ claude: 0, codex: 0, omp: 0, pi: 0 })
    expect(
      buildFeedbackSafeContext({
        ...contextInput,
        view: "settings",
        workDate: "2026-07-31",
      }),
    ).toMatchObject({ view: "settings", workDate: null })
  })
})

describe("mark this spot", () => {
  test("freezes a context-off preview as the exact body used for submission", async () => {
    const pendingRequest: { resolve?: (response: Response) => void } = {}
    const sentBodies: string[] = []
    const sentUrls: string[] = []
    setFetch(async (input, init) => {
      sentUrls.push(String(input))
      const body = String(init?.body)
      sentBodies.push(body)
      return await new Promise<Response>((resolve) => {
        pendingRequest.resolve = resolve
      })
    })
    setClipboard(async () => {})

    const user = userEvent.setup()
    const result = render(<PanelHarness />)
    const panel = await screen.findByRole("dialog", { name: "mark this spot" })
    const placeholder = within(panel).getByRole("option", { name: "choose one…" })
    expect(placeholder).toBeDisabled()
    const kind = within(panel).getByRole("combobox", { name: "kind" })
    expect(kind).toHaveValue("")
    expect(within(panel).getByRole("checkbox", { name: "include safe context" })).not.toBeChecked()
    await user.click(within(panel).getByRole("button", { name: "preview feedback" }))
    expect(within(panel).getByRole("alert")).toHaveTextContent("Choose what kind of mark this is.")
    expect(kind).toHaveFocus()
    await user.selectOptions(kind, "idea")
    const message = within(panel).getByRole("textbox", { name: "what happened?" })
    await user.type(message, "   ")
    await user.click(within(panel).getByRole("button", { name: "preview feedback" }))
    expect(within(panel).getByRole("alert")).toHaveTextContent("Say what happened before previewing.")
    expect(message).toHaveFocus()

    await user.type(message, "  A clearer day marker would help.  ")
    await user.type(within(panel).getByRole("textbox", { name: "follow-up details (optional)" }), "   ")
    await user.click(within(panel).getByRole("button", { name: "preview feedback" }))
    await waitFor(() => expect(within(panel).getByRole("heading", { name: "preview" })).toHaveFocus())
    expect(
      within(panel).getByText(
        "Feedback expires after 90 days and is deleted by the next daily cleanup. Free text and follow-up details leave this Mac only when you press send.",
      ),
    ).toBeTruthy()
    const frozenBody = feedbackBody(panel)
    const decoded = decodedFeedback(frozenBody)
    expect(decoded).toMatchObject({
      protocolVersion: 1,
      kind: "idea",
      message: "A clearer day marker would help.",
      followUp: null,
      context: null,
    })
    expect(decoded.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(new Date(decoded.createdAt).toISOString()).toBe(decoded.createdAt)

    result.rerender(
      <PanelHarness
        safeContext={{
          ...contextInput,
          view: "threads",
          bootstrap: { revision: 99, sessions: [{ source: "omp" }] },
          workDate: null,
          viewport: { width: 1440, height: 900 },
          syncError: true,
        }}
      />,
    )
    expect(feedbackBody(panel)).toBe(frozenBody)

    await user.click(within(panel).getByRole("button", { name: "send feedback" }))
    expect(await within(panel).findByRole("status")).toHaveTextContent("sending…")
    expect(within(panel).getByRole("combobox", { name: "kind" })).toBeDisabled()
    expect(within(panel).getByRole("textbox", { name: "what happened?" })).toBeDisabled()
    expect(within(panel).getByRole("button", { name: "copy feedback" })).toBeDisabled()
    expect(within(panel).getByRole("button", { name: "preview feedback" })).toBeDisabled()
    expect(within(panel).getByRole("button", { name: "sending…" })).toBeDisabled()
    expect(within(panel).getByRole("button", { name: "close mark this spot" })).not.toBeDisabled()
    expect(sentBodies).toEqual([frozenBody])
    expect(sentUrls).toEqual([endpoint])

    pendingRequest.resolve?.(
      Response.json({ protocolVersion: 1, id: decoded.id, status: "received" }, { status: 201 }),
    )
    expect(await within(panel).findByRole("status")).toHaveTextContent("trail marked — thank you")
    expect(within(panel).getByRole("textbox", { name: "what happened?" })).toHaveValue("")
    expect(within(panel).queryByRole("heading", { name: "preview" })).toBeNull()
    expect(panel).toHaveAttribute("open")
  })

  test("opts into exact safe context without serializing extra snapshot data", async () => {
    setFetch(async () => Response.json({ error: "unused" }, { status: 500 }))
    setClipboard(async () => {})
    const unsafeInput = {
      ...contextInput,
      url: "https://private-tailnet.ts.net/project/secret",
      userAgent: "private browser",
      bootstrap: {
        revision: 8,
        sessions: [
          {
            source: "codex" as const,
            cwd: "/Users/tester/private-project",
            branch: "secret",
            firstPrompt: "private prompt",
            digest: "private summary",
          },
        ],
      },
    }
    const user = userEvent.setup()
    const result = render(<PanelHarness safeContext={unsafeInput} />)
    const panel = await screen.findByRole("dialog", { name: "mark this spot" })
    await user.click(within(panel).getByRole("checkbox", { name: "include safe context" }))
    const firstBody = await prepareFeedback(user, panel, { kind: "delight", message: "This made the path clear." })
    const first = decodedFeedback(firstBody)
    expect(first.context).toEqual({
      appVersion: "0.1.0-beta.1",
      view: "days",
      revision: 8,
      workDate: "2026-07-31",
      sourceCounts: { claude: 0, codex: 1, omp: 0, pi: 0 },
      viewport: { width: 390, height: 844 },
      syncError: false,
    })
    expect(firstBody).not.toContain("tailnet")
    expect(firstBody).not.toContain("private-project")
    expect(firstBody).not.toContain("private prompt")
    expect(firstBody).not.toContain("private summary")
    expect(firstBody).not.toContain("private browser")
    result.rerender(
      <PanelHarness
        safeContext={{
          ...contextInput,
          view: "week",
          bootstrap: { revision: 100, sessions: [{ source: "omp" }] },
          viewport: { width: 1440, height: 900 },
          syncError: true,
        }}
      />,
    )
    expect(feedbackBody(panel)).toBe(firstBody)


    await user.type(within(panel).getByRole("textbox", { name: "what happened?" }), " More detail.")
    expect(within(panel).queryByRole("heading", { name: "preview" })).toBeNull()
    await user.click(within(panel).getByRole("button", { name: "preview feedback" }))
    const second = decodedFeedback(feedbackBody(panel))
    expect(second.id).not.toBe(first.id)
  })

  test("preserves a failed frozen draft across close and reopen, copy, and identical retry", async () => {
    const sentBodies: string[] = []
    let requestCount = 0
    setFetch(async (_input, init) => {
      const body = String(init?.body)
      sentBodies.push(body)
      requestCount++
      if (requestCount === 1) return Response.json({ error: "unavailable" }, { status: 503 })
      const submission = decodedFeedback(body)
      return Response.json({ protocolVersion: 1, id: submission.id, status: "received" }, { status: 200 })
    })
    const copied: string[] = []
    setClipboard(async (text) => {
      copied.push(text)
    })

    const user = userEvent.setup()
    render(<PanelHarness />)
    let panel = await screen.findByRole("dialog", { name: "mark this spot" })
    const frozenBody = await prepareFeedback(user, panel, {
      kind: "broken",
      message: "The project drawer stopped responding.",
      followUp: "It happened after changing views.",
    })
    await user.click(within(panel).getByRole("button", { name: "send feedback" }))
    expect(await within(panel).findByRole("alert")).toHaveTextContent("Feedback didn’t leave this Mac.")

    await user.click(within(panel).getByRole("button", { name: "close mark this spot" }))
    expect(panel).not.toHaveAttribute("open")
    await user.click(screen.getByRole("button", { name: "feedback" }))
    panel = await screen.findByRole("dialog", { name: "mark this spot" })
    expect(within(panel).getByRole("textbox", { name: "what happened?" })).toHaveValue(
      "The project drawer stopped responding.",
    )
    expect(feedbackBody(panel)).toBe(frozenBody)

    await user.click(within(panel).getByRole("button", { name: "copy feedback" }))
    expect(copied).toEqual([frozenBody])
    await user.click(within(panel).getByRole("button", { name: "send feedback" }))
    expect(await within(panel).findByRole("status")).toHaveTextContent("trail marked — thank you")
    expect(sentBodies).toEqual([frozenBody, frozenBody])
  })

  test("gives rate-limit failures their exact recovery message", async () => {
    setFetch(async () => new Response(null, { status: 429 }))
    setClipboard(async () => {})
    const user = userEvent.setup()
    render(<PanelHarness />)
    const panel = await screen.findByRole("dialog", { name: "mark this spot" })
    await prepareFeedback(user, panel)
    await user.click(within(panel).getByRole("button", { name: "send feedback" }))
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Too many marks right now — try again in 60 seconds.",
    )
  })

  test("keeps and selects the visible frozen body when clipboard access fails", async () => {
    setFetch(async () => Response.json({ error: "unused" }, { status: 500 }))
    setClipboard(async () => {
      throw new Error("clipboard denied")
    })
    const user = userEvent.setup()
    render(<PanelHarness />)
    const panel = await screen.findByRole("dialog", { name: "mark this spot" })
    const frozenBody = await prepareFeedback(user, panel)
    await user.click(within(panel).getByRole("button", { name: "copy feedback" }))
    expect(await within(panel).findByRole("alert")).toHaveTextContent(
      "Copy failed — select the preview text.",
    )
    expect(feedbackBody(panel)).toBe(frozenBody)
    expect(window.getSelection()?.toString()).toBe(frozenBody)
  })

  test("keeps feedback available when the hub cannot load", async () => {
    setFetch(async () => {
      throw new Error("hub unavailable")
    })
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByRole("heading", { name: "Trails couldn’t load the hub." })).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "feedback" }))
    expect(await screen.findByRole("dialog", { name: "mark this spot" })).toBeTruthy()
  })
})
