import { statSync } from "node:fs"
import { loadHubConfig, SERVER_CONFIG_PATH } from "../../cli/config"
import type { HarnessId, HarnessSelection } from "../../shared/harnesses"
import {
  createHarnessResolver,
  createHarnessSummarizer,
  resolveHarness,
  type HarnessProcessRunner,
  type HarnessResolver,
} from "./runtime"
import type { Summarizer, SummarizeErrorClass } from "./types"

export interface SummaryRuntimeStatus {
  lastSuccessAt: number | null
  lastAttemptAt: number | null
  lastErrorClass: SummarizeErrorClass | null
}

export interface SummarizerDescription {
  readonly selection: HarnessSelection
  readonly harness: HarnessId | null
}

export interface SummarizerManager {
  current(): Summarizer | null
  describe(): SummarizerDescription | null
  readonly status: SummaryRuntimeStatus
}

export interface HarnessManagerOptions {
  readonly configPath?: string
  readonly resolver?: HarnessResolver
  readonly runner?: HarnessProcessRunner
  readonly timeoutMs?: number
}

function fileStamp(path: string): string {
  try {
    const info = statSync(path)
    return `${info.mtimeMs}:${info.size}:${info.ino}`
  } catch {
    return "absent"
  }
}

export function createSummarizerManager(options: HarnessManagerOptions = {}): SummarizerManager {
  const configPath = options.configPath ?? SERVER_CONFIG_PATH
  const resolver = options.resolver ?? createHarnessResolver()
  const status: SummaryRuntimeStatus = { lastSuccessAt: null, lastAttemptAt: null, lastErrorClass: null }
  let stamp: string | null = null
  let selection: HarnessSelection | null = null

  const reload = (): void => {
    const next = fileStamp(configPath)
    if (next === stamp) return
    stamp = next
    selection = null
    status.lastSuccessAt = null
    status.lastAttemptAt = null
    status.lastErrorClass = null
    try {
      selection = loadHubConfig(configPath)?.summarizer?.harness ?? null
    } catch {
      console.warn("server configuration is invalid; summaries are paused")
    }
  }

  const description = (): SummarizerDescription | null => {
    reload()
    if (selection === null) return null
    return { selection, harness: resolveHarness(selection, resolver)?.id ?? null }
  }

  return {
    status,
    current() {
      const active = description()
      if (active?.harness === null || !active) return null
      const executable = resolver(active.harness)
      if (executable === null) return null
      return createHarnessSummarizer({ id: active.harness, executable, runner: options.runner, timeoutMs: options.timeoutMs })
    },
    describe: description,
  }
}
