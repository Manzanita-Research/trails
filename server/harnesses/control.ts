import { writeHubConfig, type SummarizerConfig } from "../../cli/config"
import { HARNESS_IDS, HARNESSES } from "../../shared/harnesses"
import type { HarnessStatusV1 } from "../../shared/protocol"
import type { SummarizerManager } from "./manager"
import { createHarnessResolver, resolveHarness, type HarnessResolver } from "./runtime"

export interface HarnessControl {
  status(): HarnessStatusV1
  activate(selection: SummarizerConfig): void
  disconnect(): void
}

export interface HarnessControlOptions {
  readonly manager: SummarizerManager
  readonly configPath?: string
  readonly resolver?: HarnessResolver
}

export function createHarnessControl(options: HarnessControlOptions): HarnessControl {
  const resolver = options.resolver ?? createHarnessResolver()
  return {
    status() {
      const selected = options.manager.describe()
      const runtime = options.manager.status
      return {
        protocolVersion: 1,
        harnesses: HARNESS_IDS.map((id) => ({
          id,
          label: HARNESSES[id].label,
          available: resolver(id) !== null,
        })),
        active: selected
          ? {
              selection: selected.selection,
              harness: selected.harness,
              state: selected.harness === null
                ? "unavailable"
                : runtime.lastErrorClass !== null
                  ? "failing"
                  : runtime.lastSuccessAt !== null
                    ? "ok"
                    : "never_ran",
              lastAttemptAt: runtime.lastAttemptAt,
              lastSuccessAt: runtime.lastSuccessAt,
              lastErrorClass: runtime.lastErrorClass,
            }
          : null,
      }
    },
    activate(selection) {
      if (resolveHarness(selection.harness, resolver) === null) throw new Error("harness is not available")
      writeHubConfig(selection, options.configPath)
    },
    disconnect() {
      writeHubConfig(null, options.configPath)
    },
  }
}
