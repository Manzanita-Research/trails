import { useState } from "react"
import type { BootstrapMutations } from "../lib/api"

type Boundary = 4 | 5 | 6 | 7
type Halo = 0 | 5 | 10 | 15

export function FirstTrailGuide({
  boundary,
  halo,
  updateSettings,
  onOrganize,
}: {
  readonly boundary: Boundary
  readonly halo: Halo
  readonly updateSettings: BootstrapMutations["updateSettings"]
  readonly onOrganize: () => void
}) {
  const [boundaryPending, setBoundaryPending] = useState(false)
  const [haloPending, setHaloPending] = useState(false)
  const [boundaryError, setBoundaryError] = useState(false)
  const [haloError, setHaloError] = useState(false)
  const [completionPending, setCompletionPending] = useState(false)
  const [completionError, setCompletionError] = useState(false)

  const saveBoundary = async (value: Boundary) => {
    setBoundaryError(false)
    setBoundaryPending(true)
    try {
      await updateSettings({ boundary: value })
    } catch {
      setBoundaryError(true)
    } finally {
      setBoundaryPending(false)
    }
  }

  const saveHalo = async (value: Halo) => {
    setHaloError(false)
    setHaloPending(true)
    try {
      await updateSettings({ halo: value })
    } catch {
      setHaloError(true)
    } finally {
      setHaloPending(false)
    }
  }

  const complete = async () => {
    setCompletionError(false)
    setCompletionPending(true)
    try {
      await updateSettings({ onboardingVersion: 1 })
    } catch {
      setCompletionError(true)
      setCompletionPending(false)
    }
  }

  return (
    <section className="first-trail-guide" aria-labelledby="first-trail-heading">
      <h1 id="first-trail-heading">your first trail</h1>
      <div className="first-trail-settings">
        <div className="first-trail-setting">
          <label htmlFor="first-trail-boundary">day starts</label>
          <select
            id="first-trail-boundary"
            value={boundary}
            disabled={boundaryPending}
            aria-describedby="first-trail-boundary-help"
            onChange={(event) => void saveBoundary(Number(event.target.value) as Boundary)}
          >
            <option value={4}>4 am</option>
            <option value={5}>5 am</option>
            <option value={6}>6 am</option>
            <option value={7}>7 am</option>
          </select>
          <p id="first-trail-boundary-help">Choose when late-night work becomes a new day.</p>
          {boundaryError && <p role="alert">That setting didn’t save. Try again.</p>}
        </div>

        <div className="first-trail-setting">
          <label htmlFor="first-trail-halo">attention halo</label>
          <select
            id="first-trail-halo"
            value={halo}
            disabled={haloPending}
            aria-describedby="first-trail-halo-help"
            onChange={(event) => void saveHalo(Number(event.target.value) as Halo)}
          >
            <option value={0}>none</option>
            <option value={5}>± 5 min</option>
            <option value={10}>± 10 min</option>
            <option value={15}>± 15 min</option>
          </select>
          <p id="first-trail-halo-help">
            nearby reading, reviewing, and thinking time counted around your prompts. The activity key below the
            timeline shows how your attention and agent runtime appear.
          </p>
          {haloError && <p role="alert">That setting didn’t save. Try again.</p>}
        </div>
      </div>

      <p className="first-trail-organizing">
        Trails starts with one engagement per repository organization; an engagement can be a client, practice, or
        life area.
      </p>
      <div className="first-trail-actions">
        <button
          className="text-action first-trail-primary"
          disabled={boundaryPending || haloPending || completionPending}
          onClick={() => void complete()}
        >
          {completionPending ? "opening your day…" : "read my day"}
        </button>
        <button className="text-action" onClick={onOrganize}>
          organize projects first
        </button>
      </div>
      {completionError && (
        <p role="alert" className="first-trail-completion-error">
          Trails couldn’t finish setup. Your day is still here; try again.
        </p>
      )}
    </section>
  )
}
