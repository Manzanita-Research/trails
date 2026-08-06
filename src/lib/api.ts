import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChatgptLoginPollV1Schema,
  ChatgptLoginStartV1Schema,
  ConnectorStatusV1Schema,
  MachinesV1Schema,
  OpenrouterLoginStartV1Schema,
  SummarizationStatusV1Schema,
  decodeExact,
  type BootstrapV1,
  type ChatgptLoginPollV1,
  type ChatgptLoginStartV1,
  type ConnectorStatusV1,
  type MachinesV1,
  type OpenrouterLoginStartV1,
  type SummarizationStatusV1,
} from "../../shared/protocol"
import type { ProviderId } from "../../shared/providers"

export interface BootstrapMutations {
  updateSettings(patch: {
    readonly boundary?: 4 | 5 | 6 | 7
    readonly halo?: 0 | 5 | 10 | 15
    readonly onboardingVersion?: 1
    readonly timezone?: string
  }): Promise<void>
  updateProject(patch: {
    readonly project: string
    readonly engagementId?: string | null
    readonly displayName?: string | null
  }): Promise<void>
  createEngagement(name: string): Promise<{ readonly id: string; readonly name: string }>
  addPocket(text: string): Promise<BootstrapV1["preferences"]["pocket"][number]>
  deletePocket(id: string): Promise<void>
}

export interface BootstrapState {
  readonly data: BootstrapV1 | null
  readonly loading: boolean
  readonly error: string | null
  readonly retry: () => Promise<void>
  readonly mutations: BootstrapMutations
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return body.error.message
    }
  } catch {}
  return `request failed (${response.status})`
}

export interface BootstrapRequester {
  fetch(incremental: boolean): Promise<void>
}

export type BootstrapRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export async function fetchMachines(
  request: BootstrapRequest = globalThis.fetch,
): Promise<MachinesV1> {
  const response = await request("/api/machines", { cache: "no-store" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(MachinesV1Schema, await response.json())
}

export async function fetchSummarization(
  request: BootstrapRequest = globalThis.fetch,
): Promise<SummarizationStatusV1> {
  const response = await request("/api/summarization", { cache: "no-store" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(SummarizationStatusV1Schema, await response.json())
}

export async function fetchConnectors(
  request: BootstrapRequest = globalThis.fetch,
): Promise<ConnectorStatusV1> {
  const response = await request("/api/connectors", { cache: "no-store" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(ConnectorStatusV1Schema, await response.json())
}

export async function startChatgptLogin(
  request: BootstrapRequest = globalThis.fetch,
): Promise<ChatgptLoginStartV1> {
  const response = await request("/api/connect/chatgpt/start", { method: "POST" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(ChatgptLoginStartV1Schema, await response.json())
}

export async function pollChatgptLogin(
  request: BootstrapRequest = globalThis.fetch,
): Promise<ChatgptLoginPollV1> {
  const response = await request("/api/connect/chatgpt/poll", { method: "POST" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(ChatgptLoginPollV1Schema, await response.json())
}

export async function startOpenrouterLogin(
  request: BootstrapRequest = globalThis.fetch,
): Promise<OpenrouterLoginStartV1> {
  const response = await request("/api/connect/openrouter/start", { method: "POST" })
  if (!response.ok) throw new Error(await errorMessage(response))
  return decodeExact(OpenrouterLoginStartV1Schema, await response.json())
}

async function connectorMutation(
  path: string,
  body: unknown,
  request: BootstrapRequest,
): Promise<void> {
  const response = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(await errorMessage(response))
}

export async function setProviderApiKey(
  provider: "openrouter" | "openai-api",
  key: string,
  request: BootstrapRequest = globalThis.fetch,
): Promise<void> {
  await connectorMutation(`/api/connect/${provider}/apikey`, { key }, request)
}

export async function activateSummarizer(
  provider: ProviderId,
  model: string,
  request: BootstrapRequest = globalThis.fetch,
): Promise<void> {
  await connectorMutation("/api/summarizer", { provider, model }, request)
}

export async function disconnectSummarizer(
  request: BootstrapRequest = globalThis.fetch,
): Promise<void> {
  await connectorMutation("/api/summarizer", null, request)
}

export async function logoutProvider(
  provider: ProviderId,
  request: BootstrapRequest = globalThis.fetch,
): Promise<void> {
  await connectorMutation(`/api/logout/${encodeURIComponent(provider)}`, undefined, request)
}


export function createBootstrapRequester(options: {
  readonly request: BootstrapRequest
  readonly read: () => BootstrapV1 | null
  readonly write: (payload: BootstrapV1) => void
  readonly setError: (message: string | null) => void
  readonly setLoading: (loading: boolean) => void
  readonly isMounted: () => boolean
}): BootstrapRequester {
  let requestSequence = 0
  let latestSettledSequence = 0
  return {
    async fetch(incremental) {
      const sequence = ++requestSequence
      const current = options.read()
      const query = incremental && current ? `?after=${current.revision}` : ""
      try {
        const response = await options.request(`/api/bootstrap${query}`, {
          headers: { Accept: "application/json" },
        })
        if (!options.isMounted() || sequence < latestSettledSequence) return
        latestSettledSequence = sequence
        if (response.status === 204) {
          options.setError(null)
          return
        }
        if (!response.ok) throw new Error(await errorMessage(response))
        const payload = (await response.json()) as BootstrapV1
        if (!options.isMounted() || sequence < latestSettledSequence) return
        const applied = options.read()
        if (payload.revision >= (applied?.revision ?? -1)) options.write(payload)
        options.setError(null)
      } catch (cause) {
        if (!options.isMounted() || sequence < latestSettledSequence) return
        latestSettledSequence = sequence
        options.setError(cause instanceof Error ? cause.message : "sync failed")
      } finally {
        if (options.isMounted()) options.setLoading(false)
      }
    },
  }
}

export function useBootstrap(): BootstrapState {
  const [data, setData] = useState<BootstrapV1 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const dataRef = useRef<BootstrapV1 | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const requesterRef = useRef<BootstrapRequester | null>(null)
  if (requesterRef.current === null) {
    requesterRef.current = createBootstrapRequester({
      request: (input, init) => fetch(input, init),
      read: () => dataRef.current,
      write: (payload) => {
        dataRef.current = payload
        setData(payload)
      },
      setError,
      setLoading,
      isMounted: () => mounted.current,
    })
  }
  const fetchBootstrap = useCallback(
    (incremental: boolean): Promise<void> => requesterRef.current!.fetch(incremental),
    [],
  )

  useEffect(() => {
    mounted.current = true
    void fetchBootstrap(false)
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void fetchBootstrap(true)
    }, 30_000)
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchBootstrap(true)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      mounted.current = false
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [fetchBootstrap])

  const mutate = useCallback(
    async (path: string, method: string, body?: unknown): Promise<unknown> => {
      try {
        const response = await fetch(path, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        if (!response.ok) throw new Error(await errorMessage(response))
        const acknowledgement: unknown = await response.json()
        await fetchBootstrap(false)
        return acknowledgement
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "mutation failed"
        setError(message)
        throw cause
      }
    },
    [fetchBootstrap],
  )

  const mutations: BootstrapMutations = {
    updateSettings: async (patch) => {
      await mutate("/api/settings", "PATCH", patch)
    },
    updateProject: async (patch) => {
      await mutate("/api/projects", "PUT", patch)
    },
    createEngagement: async (name) => {
      const response = await mutate("/api/engagements", "POST", { name })
      if (
        typeof response !== "object" ||
        response === null ||
        !("engagement" in response) ||
        typeof response.engagement !== "object" ||
        response.engagement === null ||
        !("id" in response.engagement) ||
        !("name" in response.engagement) ||
        typeof response.engagement.id !== "string" ||
        typeof response.engagement.name !== "string"
      ) {
        throw new Error("invalid engagement response")
      }
      return { id: response.engagement.id, name: response.engagement.name }
    },
    addPocket: async (text) => {
      const response = await mutate("/api/pocket", "POST", { text })
      if (typeof response !== "object" || response === null || !("item" in response)) {
        throw new Error("invalid pocket response")
      }
      return response.item as BootstrapV1["preferences"]["pocket"][number]
    },
    deletePocket: async (id) => {
      await mutate(`/api/pocket/${encodeURIComponent(id)}`, "DELETE")
    },
  }

  return {
    data,
    loading,
    error,
    retry: () => fetchBootstrap(false),
    mutations,
  }
}
