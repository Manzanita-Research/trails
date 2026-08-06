import { useEffect, useRef, useState } from "react"
import { localParts, workdayOf } from "../../shared/domain"
import { Ticks } from "./SessLine"
import {
  attentionMinutes,
  credit,
  dowName,
  engColor,
  firstMinuteOf,
  fmtClock24,
  fmtDur,
  fullDate,
  lastMinuteOf,
  type CaptureSpan,
  type DayMap,
  type DayProject,
} from "../lib/data"
import { useTrails } from "../lib/ctx"
import { HourGrid, LaneMarks, makeX, useWidth } from "./timeline"
import { ActivityKey } from "./ActivityKey"

const LANE_H = 15
const LANE_GAP = 8

function DayTimeline({
  dayProjects,
  widthPx,
  cutoff,
  active,
  storyProjects,
  onPick,
}: {
  dayProjects: DayMap
  widthPx: number
  cutoff?: number
  active?: string | null
  storyProjects: ReadonlySet<string>
  onPick?: (project: string) => void
}) {
  const t = useTrails()
  const labelW = widthPx >= 500 ? 150 : 108
  const plotW = widthPx - labelW
  const projects = [...dayProjects.entries()].sort((a, b) => firstMinuteOf(a[1]) - firstMinuteOf(b[1]))
  const H = projects.length * (LANE_H + LANE_GAP) - LANE_GAP + 34
  const X = makeX(labelW, plotW, t.boundary)
  const cutX = cutoff !== undefined ? X(cutoff) : null
  // marks always end at the cutoff, so only the right side is clear — no room there, no label
  const cutLabel = cutX !== null && cutX < widthPx - 120

  return (
    <svg
      className="day-svg"
      width={widthPx}
      height={H}
      viewBox={`0 0 ${widthPx} ${H}`}
      role="group"
      aria-label="activity timeline"
    >
      <g aria-hidden="true">
        <HourGrid X={X} topPad={0} H={H} boundary={t.boundary} />
        {cutX !== null && cutoff !== undefined && (
          <g>
            <line
              x1={cutX}
              y1={0}
              x2={cutX}
              y2={H - 24}
              stroke="var(--quiet)"
              strokeWidth={1}
              strokeDasharray="2 5"
            />
            {cutLabel && (
              <text x={cutX + 7} y={10} fill="var(--quiet)" fontSize={11}>
                indexed to {fmtClock24(cutoff)}
              </text>
            )}
          </g>
        )}
      </g>
      {projects.map(([project, data], i) => {
        const y = i * (LANE_H + LANE_GAP)
        const name = t.dispName(project)
        const isActive = project === active
        const pickProject = storyProjects.has(project) ? onPick : undefined
        const labelLimit = widthPx < 500 ? 14 : 20
        const visibleName = name.length > labelLimit ? `${name.slice(0, labelLimit - 1)}…` : name
        const firstMinute = firstMinuteOf(data)
        const lastMinute = lastMinuteOf(data)
        const accessibleLabel = `${name}; activity from ${fmtClock24(firstMinute)} to ${fmtClock24(lastMinute)}; jump to day story.`

        return (
          <g
            key={project}
            className={pickProject ? "day-lane lane lane-actionable" : "day-lane lane-inert"}
            role={pickProject ? "button" : undefined}
            tabIndex={pickProject ? 0 : undefined}
            aria-label={pickProject ? accessibleLabel : undefined}
            onClick={pickProject ? () => pickProject(project) : undefined}
            onKeyDown={
              pickProject
                ? (event) => {
                    if (event.key !== "Enter" && event.key !== " ") return
                    event.preventDefault()
                    pickProject(project)
                  }
                : undefined
            }
          >
            {pickProject && (
              <rect
                className="lane-hit"
                x={0}
                y={y - LANE_GAP / 2}
                width={widthPx}
                height={LANE_H + LANE_GAP}
                fill="transparent"
                aria-hidden="true"
              />
            )}
            <text
              x={0}
              y={y + LANE_H - 3}
              fill={isActive ? "var(--ink)" : "var(--quiet)"}
              fontSize={12.5}
              fontWeight={isActive ? 600 : 400}
              aria-hidden={pickProject ? "true" : undefined}
              aria-label={pickProject ? undefined : name}
            >
              {visibleName}
            </text>
            <g aria-hidden="true">
              <LaneMarks data={data} X={X} y={y} laneH={LANE_H} color={engColor(t.engOf(project))} project={project} />
            </g>
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
      <button
        disabled={!older}
        title={older ? "or press ←" : undefined}
        aria-keyshortcuts="ArrowLeft"
        onClick={() => older && onDayIdx(idx + 1)}
      >
        {older ? `← ${dowName(older[0])}` : "← older"}
      </button>
      <button
        disabled={!newer}
        title={newer ? "or press →" : undefined}
        aria-keyshortcuts="ArrowRight"
        onClick={() => newer && onDayIdx(idx - 1)}
      >
        {newer ? `${dowName(newer[0])} →` : "newer →"}
      </button>
    </nav>
  )
}
function captureTime({ min, max }: CaptureSpan): string {
  return min === max ? fmtClock24(min) : `${fmtClock24(min)}–${fmtClock24(max + 1)}`
}

function MidjourneyCard({
  span,
  capturesOnDay,
}: {
  span: CaptureSpan
  capturesOnDay: ReadonlySet<string>
}) {
  const { capture } = span
  if (capture.source !== "midjourney") return null
  const parentId = capture.payload.parentCaptureId
  const parentOnDay = parentId !== null && capturesOnDay.has(parentId)
  const lineage =
    capture.payload.hasParent && capture.payload.parentGrid !== null
      ? `variation ${capture.payload.parentGrid + 1}`
      : `${capture.payload.eventType} · ${capture.payload.jobType}`
  return (
    <article className="capture-card capture-card-midjourney" id={`capture-${capture.id}`}>
      <div className="capture-meta">
        {captureTime(span)} · {lineage}
      </div>
      <h3>{capture.title}</h3>
      <p>{capture.summaryInput}</p>
      {capture.payload.hasParent &&
        (parentOnDay ? (
          <button
            className="capture-lineage"
            onClick={() =>
              document.getElementById(`capture-${parentId}`)?.scrollIntoView({
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "center",
              })
            }
          >
            view parent generation
          </button>
        ) : (
          <span className="capture-lineage capture-lineage-muted">variation from earlier work</span>
        ))}
      {capture.images.length > 0 && (
        <div className="capture-images" aria-label={`${capture.title} images`}>
          {capture.images.map((image) => (
            <img
              key={image.index}
              src={image.url}
              width={image.width}
              height={image.height}
              loading="lazy"
              alt={`${capture.title}, image ${image.index + 1}`}
            />
          ))}
        </div>
      )}
    </article>
  )
}

function GranolaCard({ span }: { span: CaptureSpan }) {
  const { capture } = span
  if (capture.source !== "granola") return null
  const attendance = `${capture.payload.attendeeCount} attendee${capture.payload.attendeeCount === 1 ? "" : "s"}`
  return (
    <article className="capture-card capture-card-granola" id={`capture-${capture.id}`}>
      <div className="capture-meta">
        {captureTime(span)} · {attendance}
      </div>
      <h3>{capture.title}</h3>
      <p>{capture.summaryInput}</p>
    </article>
  )
}

function CaptureCards({
  project,
  capturesOnDay,
}: {
  project: DayProject
  capturesOnDay: ReadonlySet<string>
}) {
  const captures = [...project.captures.values()].sort((left, right) => left.min - right.min)
  if (captures.length === 0) return null
  return (
    <div className="capture-cards">
      {captures.map((span) =>
        span.capture.source === "midjourney" ? (
          <MidjourneyCard key={span.capture.id} span={span} capturesOnDay={capturesOnDay} />
        ) : (
          <GranolaCard key={span.capture.id} span={span} />
        ),
      )}
    </div>
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

  const focus = attentionMinutes(
    [...projMap.values()].map((project) => project.user),
    [...projMap.values()].flatMap((project) => [project.granola, project.midjourney]),
    t.halo,
  )
  const agentMin = new Set([...projMap.values()].flatMap((project) => [...project.all])).size
  const creditValue = credit(focus)
  const dayCredit =
    creditValue === 1 ? "full" : creditValue === 0.5 ? "half" : creditValue === 0.25 ? "quarter" : null

  // where the index stops: shown only on the workday of the latest accepted session change
  const indexedParts = t.indexedAt === null ? null : localParts(t.indexedAt, t.timezone)
  const indexedWorkday =
    indexedParts === null ? null : workdayOf(indexedParts.date, indexedParts.minute, t.boundary)
  const cutoff =
    indexedParts !== null && indexedWorkday === date
      ? indexedParts.minute < t.boundary * 60
        ? indexedParts.minute + 1440
        : indexedParts.minute
      : undefined

  // story order = timeline order: first activity of the day first
  const notes = [...projMap.entries()]
    .sort((left, right) => firstMinuteOf(left[1]) - firstMinuteOf(right[1]))
    .map(([project, data]) => ({ project, data, note: t.daySummary(date, project) }))
  const capturesOnDay = new Set(
    [...projMap.values()].flatMap((project) => [...project.captures.values()].map(({ capture }) => capture.id)),
  )

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
            {dayCredit && (
              <>
                <span className="sep">·</span>
                day credit: {dayCredit}
              </>
            )}
          </div>
          <DayTimeline
            dayProjects={projMap}
            widthPx={widthPx}
            cutoff={cutoff}
            active={activeProj}
            storyProjects={new Set(notes.map(({ project }) => project))}
            onPick={jumpTo}
          />
        </div>
        <ActivityKey />


        <h2 className="sect">the day, by project</h2>
        <div className="notes" ref={notesRef}>
          {notes.map(({ project, data, note }) => {
            const hasCoding = t.hasCodingProject(project)
            return (
              <div key={project} data-project={project} className="note">
                {hasCoding ? (
                  <button className="proj-cap" onClick={() => t.openProject(project)}>
                    <span className="sq" style={{ background: engColor(t.engOf(project)) }} />
                    {t.dispName(project)}
                  </button>
                ) : (
                  <div className="proj-cap proj-cap-static">
                    <span className="sq" style={{ background: engColor(t.engOf(project)) }} />
                    {t.dispName(project)}
                  </div>
                )}
                <div className="story-entry">
                  {hasCoding &&
                    (note ? (
                      <div className="sum">
                        <Ticks text={note} />
                      </div>
                    ) : (
                      <div className="summary-pending">
                        Coding activity is visible above. Its project summary hasn’t arrived yet.
                      </div>
                    ))}
                  <CaptureCards project={data} capturesOnDay={capturesOnDay} />
                </div>
              </div>
            )
          })}
        </div>

        <Pager older={older} newer={newer} idx={idx} onDayIdx={onDayIdx} foot />
      </div>
    </section>
  )
}
