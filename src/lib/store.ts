import { useState, useCallback } from "react"

// localStorage-backed state under the trails.* namespace
export function useStored<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(`trails.${key}`)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      localStorage.setItem(`trails.${key}`, JSON.stringify(next))
    },
    [key],
  )
  return [value, set] as const
}
