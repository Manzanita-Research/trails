import { useEffect, useRef, useState } from "react"
import { Ticks } from "./SessLine"
import {
  credit,
  creditWord,
  dowName,
  engColor,
  fmtClock24,
  fmtDur,
  focusMinutes,
  fullDate,
  shiftDate,
  type DayMap,
} from "../lib/data"
import { useTrails } from "../lib/ctx"
import { HourGrid, LaneMarks, makeX, useWidth } from "./timeline"

const LABEL_W = 150
const LANE_H = 15
const LANE_GAP = 8

function DayTimeline({
  dayProjects,
  widthPx,
  cutoff,
  active,
  onPick,
}: {
  dayProjects: DayMap
  widthPx: number
  cutoff?: number
  active?: string | null
  onPick?: (project: string) => void
}) {
  const t = useTrails()
  const plotW = Math.max(320, widthPx - LABEL_W)
  const projects = [...dayProjects.entries()].sort((a, b) => Math.min(...a[1].all) - Math.min(...b[1].all))
  const H = projects.length * (LANE_H + LANE_GAP) - LANE_GAP + 34
  const X = makeX(LABEL_W, plotW, t.boundary)
  const cutX = cutoff !== undefined ? X(cutoff) : null
  // marks always end at the cutoff, so only the right side is clear — no room there, no label
  const cutLabel = cutX !== null && cutX < widthPx - 120

  return (
    <svg className="day-svg" width={widthPx} height={H} viewBox={`0 0 ${widthPx} ${H}`} role="img" aria-label="activity timeline">
      <HourGrid X={X} topPad={0} H={H} boundary={t.boundary} />
      {cutX !== null && cutoff !== undefined && (
        <g>
          <line x1={cutX} y1={0} x2={cutX} y2={H - 24} stroke="var(--quiet)" strokeWidth={1} strokeDasharray="2 5" />
          {cutLabel && (
            <text x={cutX + 7} y={10} fill="var(--quiet)" fontSize={11}>
              indexed to {fmtClock24(cutoff)}
            </text>
          )}
        </g>
      )}
      {projects.map(([project, data], i) => {
        const y = i * (LANE_H + LANE_GAP)
        const name = t.dispName(project)
        const isActive = project === active
        return (
          <g key={project} className="lane" onClick={() => onPick?.(project)}>
            {/* one full-width hit area per row, so hover reads the whole lane,
                not just the painted marks — rows tile with half the gap each */}
            <rect
              className="lane-hit"
              x={0}
              y={y - LANE_GAP / 2}
              width={widthPx}
              height={LANE_H + LANE_GAP}
              fill="transparent"
            />
            <text
              x={0}
              y={y + LANE_H - 3}
              fill={isActive ? "var(--ink)" : "var(--quiet)"}
              fontSize={12.5}
              fontWeight={isActive ? 600 : 400}
            >
              {name.length > 20 ? name.slice(0, 19) + "…" : name}
            </text>
            <LaneMarks data={data} X={X} y={y} laneH={LANE_H} color={engColor(t.engOf(project))} project={project} />
          </g>
        )
      })}
    </svg>
  )
}

function Pager({
  older,
  newer,
  idx,
  onDayIdx,
  foot,
}: {
  older?: [string, DayMap]
  newer?: [string, DayMap]
  idx: number
  onDayIdx: (i: number) => void
  foot?: boolean
}) {
  return (
    <nav className={foot ? "pager pager-foot" : "pager"} aria-label="adjacent days">
      <button disabled={!older} title={older ? "or press ←" : undefined} onClick={() => older && onDayIdx(idx + 1)}>
        {older ? `← ${dowName(older[0])}` : "← older"}
      </button>
      <button disabled={!newer} title={newer ? "or press →" : undefined} onClick={() => newer && onDayIdx(idx - 1)}>
        {newer ? `${dowName(newer[0])} →` : "newer →"}
      </button>
    </nav>
  )
}

export function DaysView({ dayIdx, onDayIdx }: { dayIdx: number; onDayIdx: (i: number) => void }) {
  const t = useTrails()
  const [ref, width] = useWidth<HTMLElement>()
  const widthPx = Math.min(1100, width)
  const headRef = useRef<HTMLDivElement>(null)
  const notesRef = useRef<HTMLDivElement>(null)
  const [activeProj, setActiveProj] = useState<string | null>(null)
  const [stuck, setStuck] = useState(false)

  // which way the page turn travels: older days settle in from the left (the
  // past), newer from the right — no direction on first arrival. pinned per
  // date so mid-animation re-renders (scroll spy) can't drop the class
  const prevIdxRef = useRef(dayIdx)
  const pageDirRef = useRef<{ date: string; dir: "older" | "newer" | null }>({ date: "", dir: null })
  useEffect(() => {
    prevIdxRef.current = dayIdx
  }, [dayIdx])

  // the day header sticks under the topbar; the topbar's height varies (it wraps
  // on narrow screens), so it's measured into a css var rather than hardcoded
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar")
    if (!bar) return
    const set = () => document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(bar)
    return () => ro.disconnect()
  }, [])

  // scroll spy: the lane whose story is under the header reads as the active row
  useEffect(() => {
    const measure = () => {
      const head = headRef.current
      if (!head) return
      const r = head.getBoundingClientRect()
      const topPx = parseFloat(getComputedStyle(head).top)
      setStuck(Number.isFinite(topPx) && r.top <= topPx + 1)
      const line = r.bottom + 28
      let cur: string | null = null
      for (const el of notesRef.current?.querySelectorAll<HTMLElement>(".note") ?? []) {
        if (el.getBoundingClientRect().top <= line) cur = el.dataset.project ?? null
        else break
      }
      setActiveProj(cur)
    }
    let raf = 0
    const onEvt = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          measure()
        })
    }
    measure()
    addEventListener("scroll", onEvt, { passive: true })
    addEventListener("resize", onEvt)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener("scroll", onEvt)
      removeEventListener("resize", onEvt)
    }
  }, [dayIdx])

  // each day is a page: paging (buttons, arrows) starts it from the top
  useEffect(() => {
    scrollTo(0, 0)
  }, [dayIdx])

  // clicking a lane jumps to that project's note, landing just under the stuck
  // header — where the scroll spy will read it back as the active row
  const jumpTo = (project: string) => {
    const note = notesRef.current?.querySelector<HTMLElement>(`.note[data-project="${CSS.escape(project)}"]`)
    const head = headRef.current
    if (!note || !head) return
    const topPx = parseFloat(getComputedStyle(head).top) || 0
    const top = scrollY + note.getBoundingClientRect().top - (topPx + head.offsetHeight + 24)
    scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
  }

  if (!t.days.length) return <section ref={ref} className="view" />
  const idx = Math.min(dayIdx, t.days.length - 1)
  const [date, projMap] = t.days[idx]
  const older = t.days[idx + 1]
  const newer = t.days[idx - 1]

  if (pageDirRef.current.date !== date) {
    pageDirRef.current = {
      date,
      dir: dayIdx > prevIdxRef.current ? "older" : dayIdx < prevIdxRef.current ? "newer" : null,
    }
  }
  const dir = pageDirRef.current.dir

  const focus = focusMinutes([...projMap.values()].map((p) => p.user), t.halo)
  const agentMin = new Set([...projMap.values()].flatMap((p) => [...p.all])).size
  const word = creditWord[credit(focus)]

  // where the index stops: shown only on the workday the scan belongs to
  const scanD = new Date(t.scanTime)
  const scanIso = `${scanD.getFullYear()}-${String(scanD.getMonth() + 1).padStart(2, "0")}-${String(scanD.getDate()).padStart(2, "0")}`
  const scanWorkday = scanD.getHours() < t.boundary ? shiftDate(scanIso, -1) : scanIso
  const scanMin = scanD.getHours() * 60 + scanD.getMinutes()
  const cutoff = scanWorkday === date ? (scanMin < t.boundary * 60 ? scanMin + 1440 : scanMin) : undefined

  // story order = timeline order: first activity of the day first
  const notes = [...projMap.entries()]
    .sort((a, b) => Math.min(...a[1].all) - Math.min(...b[1].all))
    .map(([project]) => ({ project, note: t.daySummary(date, project) }))
    .filter((n): n is { project: string; note: string } => !!n.note)

  return (
    <section ref={ref} className="view">
      <div key={date} className={dir ? `day-page day-page-${dir}` : "day-page"}>
        <div ref={headRef} className={stuck ? "day-head is-stuck" : "day-head"}>
          <Pager older={older} newer={newer} idx={idx} onDayIdx={onDayIdx} />
          <h1 className="display">{fullDate(date)}</h1>
          <div className="facts">
            attention <b>{fmtDur(focus)}</b>
            <span className="sep">·</span>
            agents <b>{fmtDur(agentMin)}</b>
            {word && (
              <>
                <span className="sep">·</span>
                {word}
              </>
            )}
          </div>
          <DayTimeline dayProjects={projMap} widthPx={widthPx} cutoff={cutoff} active={activeProj} onPick={jumpTo} />
        </div>

        {notes.length > 0 && (
          <>
            <h2 className="sect">the day, by project</h2>
            <div className="notes" ref={notesRef}>
              {notes.map(({ project, note }) => (
                <div key={project} data-project={project} className="note">
                  <button className="proj-cap" onClick={() => t.openProject(project)}>
                    <span className="sq" style={{ background: engColor(t.engOf(project)) }} />
                    {t.dispName(project)}
                  </button>
                  <span className="sum">
                    <Ticks text={note} />
                  </span>
                </div>
              ))}
            </div>
          </>
        )}

        <Pager older={older} newer={newer} idx={idx} onDayIdx={onDayIdx} foot />
      </div>
    </section>
  )
}
