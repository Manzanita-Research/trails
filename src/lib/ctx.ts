import { createContext, useContext } from "react"
import type { DayMap, Engagement, Session, Summaries } from "./data"

// everything the views need, provided once by App
export interface Trails {
  sessions: Session[]
  summaries: Summaries | null
  scanTime: number
  boundary: number
  halo: number
  days: [string, DayMap][]
  engs: Engagement[]
  engOf: (project: string) => Engagement
  dispName: (project: string) => string
  openProject: (project: string) => void
  assign: (project: string, engId: string) => void
  addEngagement: (name: string) => string
  rename: (project: string, name: string | null) => void
  sessSummary: (id: string) => string | undefined
  daySummary: (date: string, project: string) => string | undefined
}

export const TrailsCtx = createContext<Trails>(null as unknown as Trails)
export const useTrails = () => useContext(TrailsCtx)
