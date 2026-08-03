import { Effect } from "effect"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { Source } from "../shared/domain"

export interface SourceRoot {
  readonly source: Source
  readonly path: string
  readonly layout: "project" | "codex"
  readonly restored: boolean
}

export interface SourceFile {
  readonly source: Source
  readonly path: string
}

const home = homedir()

export const DEFAULT_SOURCE_ROOTS: ReadonlyArray<SourceRoot> = [
  { source: "claude", path: join(home, ".claude/projects"), layout: "project", restored: false },
  { source: "codex", path: join(home, ".codex/sessions"), layout: "codex", restored: false },
  { source: "omp", path: join(home, ".omp/agent/sessions"), layout: "project", restored: false },
  { source: "pi", path: join(home, ".pi/agent/sessions"), layout: "project", restored: false },
  {
    source: "claude",
    path: join(home, ".manzanita/trails/backfill/claude"),
    layout: "project",
    restored: true,
  },
  {
    source: "codex",
    path: join(home, ".manzanita/trails/backfill/codex"),
    layout: "codex",
    restored: true,
  },
]

async function projectDirFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let projectDirectories: string[]
  try {
    projectDirectories = await readdir(root)
  } catch {
    return files
  }
  for (const directory of projectDirectories) {
    if (directory.endsWith("-Library-Application-Support-CodexBar-ClaudeProbe")) continue
    const full = join(root, directory)
    let entries: string[]
    try {
      entries = await readdir(full)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith(".jsonl") || name.startsWith("agent-")) continue
      files.push(join(full, name))
    }
  }
  return files
}

async function codexFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== "subagents") await visit(full)
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(full)
      }
    }
  }
  await visit(root)
  return files
}

export function parseSourceRoot(value: string): SourceRoot {
  const separator = value.indexOf("=")
  if (separator <= 0) throw new Error("source root must be <source>=<absolute-path>")
  const source = value.slice(0, separator)
  const path = value.slice(separator + 1)
  if (!(["claude", "codex", "omp", "pi"] as const).includes(source as Source)) {
    throw new Error(`unsupported source ${source}`)
  }
  if (!path.startsWith("/")) throw new Error("source root path must be absolute")
  return { source: source as Source, path, layout: source === "codex" ? "codex" : "project", restored: false }
}

export function discoverSourceFiles(roots: ReadonlyArray<SourceRoot>): Effect.Effect<SourceFile[], Error> {
  return Effect.tryPromise({
    try: async () => {
      const discovered = await Promise.all(
        roots.map(async (root) => ({
          root,
          files: root.layout === "codex" ? await codexFiles(root.path) : await projectDirFiles(root.path),
        })),
      )
      const liveNames = new Map<Source, Set<string>>()
      for (const { root, files } of discovered) {
        if (root.restored) continue
        let names = liveNames.get(root.source)
        if (!names) liveNames.set(root.source, (names = new Set()))
        for (const file of files) names.add(basename(file))
      }
      const output: SourceFile[] = []
      for (const { root, files } of discovered) {
        for (const path of files) {
          if (root.restored && liveNames.get(root.source)?.has(basename(path))) continue
          output.push({ source: root.source, path })
        }
      }
      return output.sort((a, b) => a.path.localeCompare(b.path))
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
}
