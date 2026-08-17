export const fixtureBootstrap = {
  protocolVersion: 1,
  revision: 42,
  generatedAt: "2026-08-17T18:30:00.000Z",
  indexedAt: "2026-08-17T18:29:58.000Z",
  hubUrl: "http://127.0.0.1:7414/",
  timezone: "America/Los_Angeles",
  sessions: [
    {
      id: "fixture-trails-1",
      machine: { id: "fixture-macbook", name: "MacBook" },
      source: "omp",
      cwd: "/Users/example/code/manzanita-research/trails",
      branch: "feat/herdr-plugin",
      start: "2026-08-17T16:12:00.000Z",
      end: "2026-08-17T17:48:00.000Z",
      events: 8,
      userEvents: 4,
      firstPrompt: "Build a Herdr plugin for Trails",
      activity: [
        ["2026-08-17", 552, 2, 1],
        ["2026-08-17", 575, 2, 1],
        ["2026-08-17", 618, 2, 1],
        ["2026-08-17", 648, 2, 1],
      ],
    },
    {
      id: "fixture-sign-on-1",
      machine: { id: "fixture-macbook", name: "MacBook" },
      source: "claude",
      cwd: "/Users/example/Movies/hollywood/sign-on",
      branch: "main",
      start: "2026-08-17T18:01:00.000Z",
      end: "2026-08-17T19:14:00.000Z",
      events: 6,
      userEvents: 3,
      firstPrompt: "Polish the chapter card timing",
      activity: [
        ["2026-08-17", 661, 2, 1],
        ["2026-08-17", 694, 2, 1],
        ["2026-08-17", 734, 2, 1],
      ],
    },
    {
      id: "fixture-trails-2",
      machine: { id: "fixture-mini", name: "Mini" },
      source: "codex",
      cwd: "/Users/example/code/manzanita-research/trails",
      branch: "main",
      start: "2026-08-16T20:05:00.000Z",
      end: "2026-08-16T22:22:00.000Z",
      events: 8,
      userEvents: 4,
      firstPrompt: "Verify the alpha release",
      activity: [
        ["2026-08-16", 785, 2, 1],
        ["2026-08-16", 817, 2, 1],
        ["2026-08-16", 864, 2, 1],
        ["2026-08-16", 922, 2, 1],
      ],
    },
    {
      id: "fixture-graze-1",
      machine: { id: "fixture-macbook", name: "MacBook" },
      source: "pi",
      cwd: "/Users/example/code/manzanita-research/graze",
      branch: "main",
      start: "2026-08-15T15:20:00.000Z",
      end: "2026-08-15T17:01:00.000Z",
      events: 6,
      userEvents: 3,
      firstPrompt: "Tune the capture ingestion boundary",
      activity: [
        ["2026-08-15", 500, 2, 1],
        ["2026-08-15", 548, 2, 1],
        ["2026-08-15", 601, 2, 1],
      ],
    },
  ],
  captures: [],
  summaries: {
    sessions: {
      "fixture-trails-1": "Built a read-only Herdr dashboard that discovers the existing Trails collector URL without rewriting client configuration.",
      "fixture-sign-on-1": "Refined the chapter card timing and checked the transition cadence.",
      "fixture-trails-2": "Verified the staged release artifacts and public channel metadata.",
      "fixture-graze-1": "Adjusted capture ingestion around the configured workday boundary.",
    },
    days: {
      "2026-08-17": "Trails gained a terminal-native Herdr view, while sign-on received a focused timing polish pass.",
      "2026-08-16": "Release verification and operational checks occupied the afternoon.",
      "2026-08-15": "Graze capture ingestion was tightened around day boundaries.",
    },
  },
  preferences: {
    boundary: 5,
    halo: 10,
    onboardingVersion: 1,
    assignments: {},
    customEngagements: [],
    names: {
      "code/manzanita-research/trails": "Trails",
      "Movies/hollywood/sign-on": "Sign-on",
      "code/manzanita-research/graze": "Graze",
    },
    pocket: [],
  },
} as const

export const fixtureMachines = {
  protocolVersion: 1,
  generatedAt: "2026-08-17T18:30:00.000Z",
  machines: [
    {
      id: "fixture-macbook",
      name: "MacBook",
      firstSeenAt: "2026-08-01T16:00:00.000Z",
      lastIngestedAt: "2026-08-17T18:29:51.000Z",
      lastCheckedAt: "2026-08-17T18:29:51.000Z",
      lastProcessedAt: "2026-08-17T18:29:50.000Z",
      lastError: null,
      metrics: { discovered: 18, changed: 2, uploaded: 2, ignored: 0, unchanged: 16 },
    },
    {
      id: "fixture-mini",
      name: "Mini",
      firstSeenAt: "2026-08-01T16:00:00.000Z",
      lastIngestedAt: "2026-08-17T18:28:54.000Z",
      lastCheckedAt: "2026-08-17T18:28:54.000Z",
      lastProcessedAt: "2026-08-17T18:28:52.000Z",
      lastError: null,
      metrics: { discovered: 9, changed: 0, uploaded: 0, ignored: 0, unchanged: 9 },
    },
  ],
} as const

export const fixtureHarnesses = {
  protocolVersion: 1,
  harnesses: [
    { id: "omp", label: "OMP", available: true },
    { id: "claude", label: "Claude Code", available: true },
    { id: "codex", label: "Codex", available: true },
    { id: "opencode", label: "OpenCode", available: false },
    { id: "pi", label: "Pi", available: true },
  ],
  active: {
    selection: "auto",
    harness: "omp",
    state: "ok",
    lastAttemptAt: 1_776_450_000_000,
    lastSuccessAt: 1_776_450_000_000,
    lastErrorClass: null,
  },
} as const

export function fixtureResponse(request: Request): Response {
  const url = new URL(request.url)
  if (request.method !== "GET") return Response.json({ error: { message: "method not allowed" } }, { status: 405 })
  if (url.pathname === "/api/health") return Response.json({ ok: true, revision: fixtureBootstrap.revision })
  if (url.pathname === "/api/bootstrap") return Response.json(fixtureBootstrap)
  if (url.pathname === "/api/machines") return Response.json(fixtureMachines)
  if (url.pathname === "/api/harnesses") return Response.json(fixtureHarnesses)
  return Response.json({ error: { message: "not found" } }, { status: 404 })
}
