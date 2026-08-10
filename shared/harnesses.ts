export const HARNESS_IDS = ["omp", "claude", "codex", "opencode", "pi"] as const

export type HarnessId = (typeof HARNESS_IDS)[number]
export type HarnessSelection = HarnessId | "auto"

export interface HarnessInfo {
  readonly id: HarnessId
  readonly label: string
  readonly command: string
}

export const HARNESSES: Record<HarnessId, HarnessInfo> = {
  omp: { id: "omp", label: "Oh My Pi", command: "omp" },
  claude: { id: "claude", label: "Claude Code", command: "claude" },
  codex: { id: "codex", label: "Codex", command: "codex" },
  opencode: { id: "opencode", label: "OpenCode", command: "opencode" },
  pi: { id: "pi", label: "Pi", command: "pi" },
}

/** Auto mode prefers harnesses that can disable tools and session persistence. */
export const HARNESS_AUTO_ORDER: readonly HarnessId[] = HARNESS_IDS

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value)
}

export function isHarnessSelection(value: string): value is HarnessSelection {
  return value === "auto" || isHarnessId(value)
}
