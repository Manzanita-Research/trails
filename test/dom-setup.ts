import { afterEach, expect } from "bun:test"

const NativeHeaders = globalThis.Headers
const NativeRequest = globalThis.Request
const NativeResponse = globalThis.Response

const { GlobalRegistrator } = await import("@happy-dom/global-registrator")
GlobalRegistrator.register()
globalThis.Headers = NativeHeaders
globalThis.Request = NativeRequest
globalThis.Response = NativeResponse

// Happy DOM must register before Testing Library evaluates its document-bound helpers.
const { default: _default, ...matchers } = await import("@testing-library/jest-dom/matchers")
const { cleanup } = await import("@testing-library/react")

window.resizeTo(1440, 900)

expect.extend(matchers)

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
