import { useLayoutEffect, useRef, useState } from "react"
import { runsOf, type DayProject } from "../lib/data"

export function makeX(labelW: number, plotW: number, boundary: number) {
  const x0 = boundary * 60
  return (min: number) => labelW + ((min - x0) / 1440) * plotW
}

export function HourGrid({
  X,
  topPad,
  H,
  boundary,
  withLabels = true,
}: {
  X: (min: number) => number
  topPad: number
  H: number
  boundary: number
  withLabels?: boolean
}) {
  const items = []
  for (let h = boundary; h <= boundary + 24; h += 3) {
    const x = X(h * 60)
    const hh = h % 24
    const lbl = hh === 0 ? "12am" : hh === 12 ? "noon" : hh < 12 ? `${hh}am` : `${hh - 12}pm`
    items.push(
      <g key={h}>
        <line x1={x} y1={topPad - 6} x2={x} y2={H - 12} stroke="var(--hairline)" strokeWidth={1} />
        {withLabels && (
          <text x={x} y={topPad - 9} fill="var(--muted)" fontSize={10} textAnchor="middle">
            {lbl}
          </text>
        )}
      </g>,
    )
  }
  return <>{items}</>
}

// agent wash underneath, solid user marks on top; data attrs feed the shared tooltip
export function LaneMarks({
  data,
  X,
  y,
  laneH,
  color,
  project,
}: {
  data: DayProject
  X: (min: number) => number
  y: number
  laneH: number
  color: string
  project: string
}) {
  return (
    <>
      {runsOf(data.all).map(([a, b]) => (
        <rect
          key={`a${a}`}
          className="hit"
          data-p={project}
          data-a={a}
          data-b={b}
          data-kind="agent"
          x={X(a)}
          y={y + 3}
          width={Math.max(2, X(b + 1) - X(a))}
          height={laneH - 6}
          rx={2}
          fill={color}
          opacity={0.28}
        />
      ))}
      {runsOf(data.user).map(([a, b]) => (
        <rect
          key={`u${a}`}
          className="hit"
          data-p={project}
          data-a={a}
          data-b={b}
          data-kind="you"
          x={X(a)}
          y={y + 1.5}
          width={Math.max(2.5, X(b + 1) - X(a))}
          height={laneH - 3}
          rx={2.5}
          fill={color}
        />
      ))}
    </>
  )
}

// measured width of a container, debounced on resize
export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(1032)
  useLayoutEffect(() => {
    const measure = () => ref.current && setW(ref.current.clientWidth || 1032)
    measure()
    let timer: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(timer)
      timer = setTimeout(measure, 150)
    }
    addEventListener("resize", onResize)
    return () => {
      clearTimeout(timer)
      removeEventListener("resize", onResize)
    }
  }, [])
  return [ref, w]
}
