import { Effect } from "effect"
import { isAbsolute, resolve } from "node:path"
import { runCaptureCollection, type CaptureFetcher } from "../collector/captures"
import {
  MidjourneyAdapter,
  type MidjourneyBrowserBridge,
} from "../collector/midjourney"
import {
  DEFAULT_STATE_PATH,
  collectorTargetsMatch,
  loadCollectorState,
  type CollectorTarget,
} from "../collector/state"
import {
  loadCollectorConfig,
  normalizeCollectorServer,
  type CollectorConfig,
} from "./config"

export interface MidjourneyCommandDependencies {
  readonly loadConfig?: () => CollectorConfig | null
  readonly browser?: MidjourneyBrowserBridge
  readonly fetch?: CaptureFetcher
  readonly output?: (message: string) => void
}

function valueAfter(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function valuesAfter(args: ReadonlyArray<string>, flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]!)
  }
  return values
}

function limitOf(value: string | undefined): number {
  if (value === undefined) return 50
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit must be between 1 and 50")
  return limit
}

export async function runMidjourneyCommand(
  args: ReadonlyArray<string>,
  dependencies: MidjourneyCommandDependencies = {},
): Promise<void> {
  const config = (dependencies.loadConfig ?? loadCollectorConfig)()
  const serverValue = valueAfter(args, "--server") ?? config?.server
  const deviceId = valueAfter(args, "--device-id") ?? config?.deviceId
  const deviceName = valueAfter(args, "--device-name") ?? config?.deviceName
  if (!serverValue || !deviceId || !deviceName) {
    throw new Error("Midjourney capture requires a configured collector target")
  }
  const target: CollectorTarget = {
    server: normalizeCollectorServer(serverValue),
    deviceId: deviceId.trim(),
    deviceName: deviceName.trim(),
  }
  const statePath = resolve(valueAfter(args, "--state") ?? DEFAULT_STATE_PATH)
  const jobs = valuesAfter(args, "--job")
  if (new Set(jobs).size !== jobs.length) throw new Error("--job values must be unique")
  for (const job of jobs) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(job)) throw new Error("--job contains an invalid Midjourney job id")
  }
  const projectValue = valueAfter(args, "--project")
  if (jobs.length > 0 && !projectValue) throw new Error("--job requires --project")
  if (projectValue && !isAbsolute(projectValue)) throw new Error("--project must be an absolute path")
  const adapter = new MidjourneyAdapter({
    jobs,
    project: projectValue ?? null,
    since: valueAfter(args, "--since"),
    limit: limitOf(valueAfter(args, "--limit")),
    browser: dependencies.browser,
    fetch: dependencies.fetch,
  })

  if (args.includes("--dry-run")) {
    const state = await Effect.runPromise(loadCollectorState(statePath))
    const cursor = state && collectorTargetsMatch(state.target, target) ? state.captureCursors.midjourney : null
    const result = await adapter.collect(cursor)
    const images = result.captures.reduce((total, capture) => total + capture.images.length, 0)
    const cursorFact = result.nextCursor === cursor ? "unchanged" : "would advance"
    ;(dependencies.output ?? console.log)(
      `midjourney dry run: source midjourney; captures ${result.captures.length}; images ${images}; cursor ${cursorFact}`,
    )
    return
  }

  const result = await Effect.runPromise(
    runCaptureCollection({
      adapter,
      ...target,
      statePath,
      fetch: dependencies.fetch,
    }),
  )
  ;(dependencies.output ?? console.log)(
    `captured ${result.uploaded} Midjourney generation${result.uploaded === 1 ? "" : "s"}; cursor ${result.nextCursor === null ? "unchanged" : "saved"}`,
  )
}
