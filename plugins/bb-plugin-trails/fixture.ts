export const fixture = {
  protocolVersion: 1, revision: 9, timezone: "America/Los_Angeles",
  preferences: { boundary: 5, halo: 5, names: { "code/trails": "Trails" } },
  summaries: { days: { "2026-09-15|code/trails": "Built the plugin", "2026-09-15|code/other": "Unrelated project summary" }, sessions: { s1: "Connected Trails to BB" } },
  sessions: [
    { id: "s1", source: "codex", machine: { name: "Laptop" }, cwd: "/Users/example/code/trails", branch: "main", start: "2026-09-16T06:50:00Z", end: "2026-09-16T07:10:00Z", firstPrompt: "Make a plugin", activity: [["2026-09-15", 1438, 2, 1], ["2026-09-16", 2, 2, 1]], digest: "PRIVATE_DIGEST", sourceSessionId: "PRIVATE_ID" },
    { id: "s2", source: "claude", machine: { name: "Desktop" }, cwd: "/Users/example/code/other", branch: null, start: "2026-09-16T07:00:00Z", end: "2026-09-16T08:00:00Z", firstPrompt: null, activity: [["2026-09-16", 2, 2, 1], ["2026-09-16", 400, 2, 0]] },
  ], captures: [{ content: "PRIVATE_CAPTURE" }],
};
