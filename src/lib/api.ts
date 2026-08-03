import { useCallback, useEffect, useRef, useState } from "react"
import type { BootstrapV1 } from "../../shared/protocol"

export interface BootstrapMutations {
  updateSettings(patch: { readonly boundary?: 4 | 5 | 6 | 7; readonly halo?: 0 | 5 | 10 | 15 }): Promise<void>
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

export function useBootstrap(): BootstrapState {
  const [data, setData] = useState<BootstrapV1 | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const dataRef = useRef<BootstrapV1 | null>(null)
  const requestSequence = useRef(0)
  const latestSettledSequence = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    dataRef.current = data
  }, [data])

  const fetchBootstrap = useCallback(async (incremental: boolean): Promise<void> => {
    const sequence = ++requestSequence.current
    const current = dataRef.current
    const query = incremental && current ? `?after=${current.revision}` : ""
    try {
      const response = await fetch(`/api/bootstrap${query}`, { headers: { Accept: "application/json" } })
      if (!mounted.current) return
      if (sequence < latestSettledSequence.current) return
      latestSettledSequence.current = sequence
      if (response.status === 204) {
        setError(null)
        return
      }
      if (!response.ok) throw new Error(await errorMessage(response))
      const payload = (await response.json()) as BootstrapV1
      const applied = dataRef.current
      if (payload.revision >= (applied?.revision ?? -1)) {
        dataRef.current = payload
        setData(payload)
      }
      setError(null)
    } catch (cause) {
      if (!mounted.current || sequence < latestSettledSequence.current) return
      latestSettledSequence.current = sequence
      setError(cause instanceof Error ? cause.message : "sync failed")
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

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
