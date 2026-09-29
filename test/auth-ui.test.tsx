import { afterEach, expect, test } from "bun:test"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AuthenticatedApp } from "../src/components/AuthenticatedApp"
import { createApp } from "../server/app"
import { openDatabase } from "../server/db"
import { issueCredential } from "../server/auth"

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test("browser signs in before reading timeline data and signs out without storing the owner token", async () => {
  const db = openDatabase(":memory:")
  const owner = issueCredential(db, "owner")
  const origin = "http://localhost:7412"
  const app = createApp({ db })
  let cookie = ""
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (cookie) headers.set("cookie", cookie)
    if (init?.method === "POST") headers.set("origin", origin)
    const url = new URL(String(input), origin)
    calls.push(url.pathname)
    const response = await app(new Request(url, { ...init, headers }))
    const received = response.headers.get("set-cookie")
    if (received) cookie = received.split(";")[0]
    return response
  }) as typeof fetch
  try {
    const user = userEvent.setup()
    const view = render(<AuthenticatedApp />)
    await screen.findByRole("heading", { name: "Sign in to Trails" })
    expect(calls).toEqual(["/api/auth/session"])
    await user.type(screen.getByLabelText("Owner credential"), "invalid")
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign-in failed")
    await user.clear(screen.getByLabelText("Owner credential"))
    await user.type(screen.getByLabelText("Owner credential"), owner.token)
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    await screen.findByRole("button", { name: "Sign out" })
    await waitFor(() => expect(calls).toContain("/api/bootstrap"))
    expect(document.body.textContent).not.toContain(owner.token)
    expect(JSON.stringify(localStorage)).not.toContain(owner.token)
    await user.click(screen.getByRole("button", { name: "Sign out" }))
    await screen.findByRole("heading", { name: "Sign in to Trails" })
    expect(screen.getByLabelText("Owner credential")).toHaveValue("")
    view.unmount()
  } finally { db.close() }
})
