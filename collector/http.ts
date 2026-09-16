// Acknowledgments contain only three numbers; leave room for protocol additions.
export const MAX_ACKNOWLEDGMENT_BYTES = 8 * 1024
export const REQUEST_TIMEOUT_MS = 15_000
export const CYCLE_TIMEOUT_MS = 120_000

export function abortable<A>(pending: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort)
      reject(signal.reason)
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function discard(response: Response): void {
  // Cancellation itself can be asynchronous. Never let cleanup hold the lock.
  if (!response.body?.locked) void response.body?.cancel().catch(() => {})
}

export async function collectorRequest<A>(
  fetcher: typeof globalThis.fetch,
  endpoint: URL,
  init: RequestInit,
  parentSignal: AbortSignal,
  timeoutMs: number,
  consume: (response: Response, signal: AbortSignal) => Promise<A>,
): Promise<A> {
  parentSignal.throwIfAborted()
  const controller = new AbortController()
  const signal = controller.signal
  const abort = () => controller.abort(parentSignal.reason)
  parentSignal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("collector request timed out")), timeoutMs)
  let response: Response | undefined
  try {
    const pending = fetcher(endpoint, { ...init, signal })
    // Also dispose of late responses from a transport that ignores cancellation.
    void pending.then((value) => { if (signal.aborted) discard(value) }, () => {})
    response = await abortable(pending, signal)
    signal.throwIfAborted()
    return await abortable(consume(response, signal), signal)
  } finally {
    clearTimeout(timer)
    parentSignal.removeEventListener("abort", abort)
    controller.abort()
    if (response) discard(response)
  }
}

export async function readAcknowledgment(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null && Number(declaredLength) > MAX_ACKNOWLEDGMENT_BYTES) {
    throw new Error("ingest response too large")
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error("invalid ingest response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await abortable(reader.read(), signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_ACKNOWLEDGMENT_BYTES) throw new Error("ingest response too large")
      if (chunk.value.byteLength) chunks.push(chunk.value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"))
  } catch {
    throw new Error("invalid ingest response")
  }
}
