import { afterEach, expect } from "bun:test"

const NativeFetch = globalThis.fetch
const NativeHeaders = globalThis.Headers
const NativeRequest = globalThis.Request
const NativeResponse = globalThis.Response
const NativeAbortController = globalThis.AbortController
const NativeAbortSignal = globalThis.AbortSignal

const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
GlobalRegistrator.register()
globalThis.Headers = NativeHeaders
globalThis.Request = NativeRequest
globalThis.fetch = NativeFetch
globalThis.Response = NativeResponse
// Keep signals compatible with the native HTTP constructors restored above.
globalThis.AbortController = NativeAbortController
globalThis.AbortSignal = NativeAbortSignal

// Happy DOM must register before Testing Library evaluates its document-bound helpers.
const { default: _default, ...matchers } = await import("@testing-library/jest-dom/matchers")
const { cleanup } = await import("@testing-library/react")

window.resizeTo(1440, 900)

expect.extend(matchers)

// Happy DOM exposes dialog APIs but does not translate Escape key presses into native cancel events.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return
  const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")
  if (dialog) dialog.dispatchEvent(new Event("cancel", { cancelable: true }))
})

const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  window.localStorage.clear()
  window.sessionStorage.clear()
  window.history.replaceState(null, "", "/")
  document.title = ""
  document.documentElement.removeAttribute("class")
  document.documentElement.removeAttribute("style")
  document.body.removeAttribute("class")
  document.body.removeAttribute("style")
  document.body.replaceChildren()
  window.scrollTo(0, 0)
  window.resizeTo(1440, 900)
})
