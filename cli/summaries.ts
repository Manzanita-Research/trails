import { loadHubConfig, writeHubConfig } from "./config"
import {
  HARNESS_IDS,
  HARNESSES,
  isHarnessSelection,
  type HarnessSelection,
} from "../shared/harnesses"
import { createHarnessResolver, resolveHarness, type HarnessResolver } from "../server/harnesses/runtime"

export interface SummariesCommandOptions {
  readonly configPath?: string
  readonly resolver?: HarnessResolver
  readonly log?: (message: string) => void
}

export function runSummariesCommand(args: string[], options: SummariesCommandOptions = {}): void {
  const command = args[0] ?? "status"
  const resolver = options.resolver ?? createHarnessResolver()
  const log = options.log ?? console.log
  if (command === "status") {
    let selection: HarnessSelection | null = null
    try {
      selection = loadHubConfig(options.configPath)?.summarizer?.harness ?? null
    } catch {}
    const resolved = selection === null ? null : resolveHarness(selection, resolver)
    log(selection === null
      ? "summaries off"
      : `summaries ${selection} -> ${resolved?.id ?? "unavailable"}`)
    for (const id of HARNESS_IDS) log(`${id}: ${resolver(id) === null ? "not found" : "available"}`)
    return
  }
  if (command === "off") {
    writeHubConfig(null, options.configPath)
    log("summaries off")
    return
  }
  if (command === "use") {
    const selection = args[1]
    if (!selection || !isHarnessSelection(selection)) {
      throw new Error(`summaries use requires auto or one of: ${HARNESS_IDS.join(", ")}`)
    }
    const resolved = resolveHarness(selection, resolver)
    if (resolved === null) throw new Error("selected harness is not installed")
    writeHubConfig({ harness: selection }, options.configPath)
    log(`summaries use ${selection} -> ${HARNESSES[resolved.id].label}`)
    return
  }
  throw new Error("summaries requires status, use HARNESS, or off")
}
