import { buildModel, fetchSnapshot, resolveServer, type ServerResolution, type TrailsSnapshot } from "./trails"
import { renderDashboard, type Screen, type ViewState } from "./render"

const CLEAR = "\u001b[H\u001b[2J"
const ENTER_ALT = "\u001b[?1049h\u001b[?25l"
const LEAVE_ALT = "\u001b[?25h\u001b[?1049l"

function timeoutFromEnv(value: string | undefined): number {
  if (value === undefined) return 5_000
  const timeout = Number(value)
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 30_000) {
    throw new Error("TRAILS_HERDR_TIMEOUT_MS must be an integer from 500 to 30000")
  }
  return timeout
}

function friendlyNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : "connection failed"
  if (/fetch failed|network|dns|socket|connection refused/i.test(message)) {
    return "Cannot reach Trails. Check Tailscale, then press r."
  }
  return message
}

class TrailsTui {
  private snapshot: TrailsSnapshot | null = null
  private screen: Screen = "days"
  private selected: Record<Screen, number> = { days: 0, week: 0, threads: 0, status: 0 }
  private detail = false
  private help = false
  private loading = true
  private error: string | null = null
  private refreshing = false
  private stopped = false
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly resolution: ServerResolution,
    private readonly timeoutMs: number,
  ) {}

  start(): void {
    process.stdout.write(ENTER_ALT)
    process.stdin.setEncoding("utf8")
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on("data", this.onInput)
    process.stdout.on("resize", this.render)
    process.once("SIGINT", this.onSignal)
    process.once("SIGTERM", this.onSignal)
    this.render()
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), 30_000)
  }

  private viewState(): ViewState {
    return {
      screen: this.screen,
      selected: this.selected,
      detail: this.detail,
      help: this.help,
      loading: this.loading,
      error: this.error,
    }
  }

  private render = (): void => {
    if (this.stopped) return
    process.stdout.write(`${CLEAR}${renderDashboard({
      snapshot: this.snapshot,
      resolution: this.resolution,
      state: this.viewState(),
      width: process.stdout.columns || 100,
      height: process.stdout.rows || 30,
      colors: process.env.NO_COLOR === undefined,
    })}`)
  }

  private refresh = async (): Promise<void> => {
    if (this.refreshing || this.stopped) return
    this.refreshing = true
    this.loading = true
    this.render()
    try {
      this.snapshot = await fetchSnapshot(this.resolution.url, { timeoutMs: this.timeoutMs })
      this.error = null
      this.clampSelection()
    } catch (error) {
      this.error = friendlyNetworkError(error)
    } finally {
      this.loading = false
      this.refreshing = false
      this.render()
    }
  }

  private clampSelection(): void {
    if (!this.snapshot) return
    const model = buildModel(this.snapshot.bootstrap)
    this.selected.days = Math.min(this.selected.days, Math.max(0, model.days.length - 1))
    this.selected.threads = Math.min(this.selected.threads, Math.max(0, model.threads.length - 1))
  }

  private selectionLimit(): number {
    if (!this.snapshot) return 0
    const model = buildModel(this.snapshot.bootstrap)
    if (this.screen === "days") return model.days.length
    if (this.screen === "threads") return model.threads.length
    return 0
  }

  private move(delta: number): void {
    const limit = this.selectionLimit()
    if (limit === 0 || this.detail) return
    this.selected[this.screen] = Math.max(0, Math.min(limit - 1, this.selected[this.screen] + delta))
  }

  private setScreen(screen: Screen): void {
    this.screen = screen
    this.detail = false
    this.help = false
  }

  private onInput = (chunk: string): void => {
    if (chunk === "q" || chunk === "\u0003") return this.stop(0)
    if (chunk === "?") this.help = !this.help
    else if (chunk === "r") void this.refresh()
    else if (chunk === "1") this.setScreen("days")
    else if (chunk === "2") this.setScreen("week")
    else if (chunk === "3") this.setScreen("threads")
    else if (chunk === "4") this.setScreen("status")
    else if (chunk === "\u001b[A" || chunk === "k") this.move(-1)
    else if (chunk === "\u001b[B" || chunk === "j") this.move(1)
    else if (chunk === "\r" || chunk === "\n") {
      if (!this.help && (this.screen === "days" || this.screen === "threads") && this.selectionLimit() > 0) this.detail = true
    } else if (chunk === "\u001b" || chunk === "\u001b[D") {
      if (this.help) this.help = false
      else this.detail = false
    }
    this.render()
  }

  private onSignal = (): void => this.stop(0)

  private stop(code: number): void {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    process.stdin.off("data", this.onInput)
    process.stdout.off("resize", this.render)
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    process.stdout.write(LEAVE_ALT)
    process.exit(code)
  }
}

async function printSnapshot(resolution: ServerResolution, timeoutMs: number): Promise<void> {
  const snapshot = await fetchSnapshot(resolution.url, { timeoutMs })
  const state: ViewState = {
    screen: "days",
    selected: { days: 0, week: 0, threads: 0, status: 0 },
    detail: false,
    help: false,
    loading: false,
    error: null,
  }
  process.stdout.write(`${renderDashboard({
    snapshot,
    resolution,
    state,
    width: Number(process.env.COLUMNS) || 100,
    height: Number(process.env.LINES) || 30,
    colors: false,
  })}\n`)
}

async function main(): Promise<void> {
  const resolution = resolveServer()
  const timeoutMs = timeoutFromEnv(process.env.TRAILS_HERDR_TIMEOUT_MS)
  if (process.argv.includes("--snapshot")) return printSnapshot(resolution, timeoutMs)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Trails needs a terminal; use --snapshot for non-interactive output")
  }
  new TrailsTui(resolution, timeoutMs).start()
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
