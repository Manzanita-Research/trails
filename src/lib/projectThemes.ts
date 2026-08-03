export type ThemeSurface = "flat" | "dots" | "grid"
export type ThemeHeading = "standard" | "uppercase" | "underlined"
export type ThemeCorners = "square" | "soft"

type ThemeSlots = readonly [string, string, string, string, string, string, string, string]

export interface ProjectTheme {
  id: string
  projectKeys: readonly string[]
  source: string
  tokens: {
    ground: string
    ink: string
    prose: string
    quiet: string
    muted: string
    hairline: string
    accent: string
    accentAlt: string
    display: string
    sans: string
    serif: string
    mono: string
    slots: ThemeSlots
  }
  treatment: {
    surface: ThemeSurface
    heading: ThemeHeading
    corners: ThemeCorners
  }
}

export const DEFAULT_PROJECT_THEME: ProjectTheme = {
  id: "trails",
  projectKeys: ["code/manzanita-research/trails", "code/manzanita-research/trails-project-world-themes"],
  source: "~/code/manzanita-research/trails/DESIGN.md",
  tokens: {
    ground: "#faf7f1",
    ink: "#232936",
    prose: "#3a3f4c",
    quiet: "#62687a",
    muted: "#9a988f",
    hairline: "rgba(35, 41, 54, 0.12)",
    accent: "#33406e",
    accentAlt: "#cf8f3a",
    display: '"General Sans", system-ui, -apple-system, sans-serif',
    sans: '"General Sans", system-ui, -apple-system, sans-serif',
    serif: '"Recia", Georgia, serif',
    mono: '"Commit Mono", ui-monospace, "SF Mono", monospace',
    slots: ["#33406e", "#cf8f3a", "#5b7c99", "#8a7fa8", "#6b7bb0", "#a4622a", "#3c5a73", "#5f5680"],
  },
  treatment: { surface: "flat", heading: "standard", corners: "square" },
}

export const PROJECT_THEMES: readonly ProjectTheme[] = [
  DEFAULT_PROJECT_THEME,
  {
    id: "hearth",
    projectKeys: ["code/manzanita-research/hearth"],
    source: "~/code/manzanita-research/hearth/DESIGN.md",
    tokens: {
      ground: "#f5f6f3",
      ink: "#16181a",
      prose: "#303437",
      quiet: "#555b61",
      muted: "#899095",
      hairline: "rgba(22, 24, 26, 0.18)",
      accent: "#d93025",
      accentAlt: "#d0a23c",
      display: "system-ui, -apple-system, sans-serif",
      sans: "system-ui, -apple-system, sans-serif",
      serif: "system-ui, -apple-system, sans-serif",
      mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      slots: ["#6f8791", "#8d7d96", "#9a846c", "#71877b", "#7a8096", "#8d7770", "#526b75", "#665d72"],
    },
    treatment: { surface: "flat", heading: "uppercase", corners: "square" },
  },
  {
    id: "tlbox",
    projectKeys: ["code/manzanita-research/tlbox"],
    source: "~/code/manzanita-research/tlbox/DESIGN.md",
    tokens: {
      ground: "oklch(97.2% 0.008 90)",
      ink: "oklch(28% 0.012 75)",
      prose: "oklch(32% 0.012 75)",
      quiet: "oklch(48% 0.012 75)",
      muted: "oklch(65% 0.01 80)",
      hairline: "oklch(28% 0.012 75 / 18%)",
      accent: "oklch(48% 0.19 25)",
      accentAlt: "oklch(82% 0.05 240)",
      display: '"Chalkboard SE", "Marker Felt", cursive',
      sans: '"Avenir Next", system-ui, sans-serif',
      serif: '"Avenir Next", system-ui, sans-serif',
      mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      slots: [
        "oklch(55% 0.19 25)",
        "oklch(72% 0.13 95)",
        "oklch(68% 0.09 240)",
        "oklch(62% 0.11 145)",
        "oklch(66% 0.11 305)",
        "oklch(65% 0.1 55)",
        "oklch(54% 0.08 205)",
        "oklch(50% 0.06 75)",
      ],
    },
    treatment: { surface: "dots", heading: "underlined", corners: "square" },
  },
  {
    id: "graze",
    projectKeys: ["code/manzanita-research/graze"],
    source: "~/code/manzanita-research/graze/DESIGN.md",
    tokens: {
      ground: "oklch(96% 0.018 92)",
      ink: "oklch(20% 0.018 255)",
      prose: "oklch(27% 0.018 255)",
      quiet: "oklch(38% 0.018 255)",
      muted: "oklch(58% 0.015 255)",
      hairline: "oklch(82% 0.025 88)",
      accent: "oklch(52% 0.13 151)",
      accentAlt: "oklch(76% 0.13 83)",
      display: 'ui-rounded, "Avenir Next", system-ui, sans-serif',
      sans: 'ui-rounded, "Avenir Next", system-ui, sans-serif',
      serif: '"Avenir Next", system-ui, sans-serif',
      mono: 'ui-monospace, "SFMono-Regular", Menlo, monospace',
      slots: [
        "oklch(52% 0.13 151)",
        "oklch(70% 0.13 83)",
        "oklch(61% 0.095 235)",
        "oklch(57% 0.16 305)",
        "oklch(57% 0.12 42)",
        "oklch(47% 0.1 170)",
        "oklch(52% 0.08 255)",
        "oklch(48% 0.09 92)",
      ],
    },
    treatment: { surface: "grid", heading: "standard", corners: "soft" },
  },
]

export const THEME_VARIABLE_KEYS = [
  "--ground",
  "--ink",
  "--prose",
  "--quiet",
  "--muted",
  "--hairline",
  "--theme-accent",
  "--theme-accent-alt",
  "--display",
  "--sans",
  "--serif",
  "--mono",
  "--theme-radius",
  "--s1",
  "--s2",
  "--s3",
  "--s4",
  "--s5",
  "--s6",
  "--s7",
  "--s8",
] as const

export function themeForProject(project: string | null): ProjectTheme {
  if (!project) return DEFAULT_PROJECT_THEME
  return PROJECT_THEMES.find((theme) => theme.projectKeys.includes(project)) ?? DEFAULT_PROJECT_THEME
}

export function themeVariables(theme: ProjectTheme): Record<(typeof THEME_VARIABLE_KEYS)[number], string> {
  const { tokens } = theme
  return {
    "--ground": tokens.ground,
    "--ink": tokens.ink,
    "--prose": tokens.prose,
    "--quiet": tokens.quiet,
    "--muted": tokens.muted,
    "--hairline": tokens.hairline,
    "--theme-accent": tokens.accent,
    "--theme-accent-alt": tokens.accentAlt,
    "--display": tokens.display,
    "--sans": tokens.sans,
    "--serif": tokens.serif,
    "--mono": tokens.mono,
    "--theme-radius": theme.treatment.corners === "soft" ? "10px" : "0px",
    "--s1": tokens.slots[0],
    "--s2": tokens.slots[1],
    "--s3": tokens.slots[2],
    "--s4": tokens.slots[3],
    "--s5": tokens.slots[4],
    "--s6": tokens.slots[5],
    "--s7": tokens.slots[6],
    "--s8": tokens.slots[7],
  }
}
