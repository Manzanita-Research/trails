import { createContext, useContext } from "react"
import type { DayMap, Engagement, Session, Summaries } from "./data"
import type { BootstrapV1 } from "../../shared/protocol"

// everything the views need, provided once by App
export interface Trails {
  sessions: Session[]
  summaries: Summaries
  scanTime: number
  boundary: number
  halo: number
  days: [string, DayMap][]
  engs: Engagement[]
  engOf: (project: string) => Engagement
  dispName: (project: string) => string
  openProject: (project: string) => void
  openDay: (date: string) => void
  assign: (project: string, engId: string) => Promise<void>
  addEngagement: (name: string) => Promise<string>
  rename: (project: string, name: string | null) => Promise<void>
  pocket: BootstrapV1["preferences"]["pocket"]
  addPocket: (text: string) => Promise<void>
  deletePocket: (id: string) => Promise<void>
  sessSummary: (id: string) => string | undefined
  daySummary: (date: string, project: string) => string | undefined
}

export const TrailsCtx = createContext<Trails>(null as unknown as Trails)
export const useTrails = () => useContext(TrailsCtx)
