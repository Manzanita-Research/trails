import { describe, expect, it } from "bun:test"
import {
  DEFAULT_PROJECT_THEME,
  PROJECT_THEMES,
  THEME_VARIABLE_KEYS,
  themeForProject,
  themeVariables,
} from "./projectThemes"

describe("project themes", () => {
  it("resolves exact normalized project paths", () => {
    expect(themeForProject("code/manzanita-research/trails").id).toBe("trails")
    expect(themeForProject("code/manzanita-research/hearth").id).toBe("hearth")
    expect(themeForProject("code/manzanita-research/tlbox").id).toBe("tlbox")
    expect(themeForProject("code/manzanita-research/graze").id).toBe("graze")
  })

  it("recognizes the isolated Trails worktree without basename matching", () => {
    expect(themeForProject("code/manzanita-research/trails-project-world-themes").id).toBe("trails")
    expect(themeForProject("other/team/hearth")).toBe(DEFAULT_PROJECT_THEME)
  })

  it("falls back to the current Trails system", () => {
    expect(themeForProject(null)).toBe(DEFAULT_PROJECT_THEME)
    expect(themeForProject("code/example/unconfigured-project")).toBe(DEFAULT_PROJECT_THEME)
  })

  it("exposes only the approved CSS variable contract", () => {
    const expected = [...THEME_VARIABLE_KEYS].sort()
    for (const theme of PROJECT_THEMES) {
      const variables = themeVariables(theme)
      expect(Object.keys(variables).sort()).toEqual(expected)
      expect(Object.values(variables).every((value) => value.length > 0)).toBe(true)
      expect(theme.tokens.slots).toHaveLength(8)
    }
  })

  it("keeps the four environments visually distinguishable", () => {
    expect(new Set(PROJECT_THEMES.map((theme) => theme.tokens.ground)).size).toBe(PROJECT_THEMES.length)
    expect(new Set(PROJECT_THEMES.map((theme) => theme.tokens.accent)).size).toBe(PROJECT_THEMES.length)
    expect(new Set(PROJECT_THEMES.map((theme) => theme.tokens.sans)).size).toBe(PROJECT_THEMES.length)
  })
})
