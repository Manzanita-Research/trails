import { expect, test } from "bun:test";
import { createFakePluginHost, makeHostResponse, makeThreadResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin, { parseArgs } from "./server";
import { reportSchema } from "./contract";
const report = reportSchema.parse({ source: "local hub", fetchedAt: "2026-09-16T12:00:00Z", timezone: null, revision: null, total: 0, nextOffset: null, warnings: [], days: [], projects: [], machines: [], summaries: null });

test("routes RPC, CLI, and agent queries to the requested or thread machine", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "trails", settings: { machine: "default-host" },
    sdk: { hosts: { list: async () => [makeHostResponse({ id: "default-host", name: "Default" })] },
      threads: { get: async () => makeThreadResponse({ environmentId: "env-test" }) },
      environments: { get: async () => ({ hostId: "thread-host" }) as never },
    },
    experimental_callHostRpc: async () => report,
  });
  plugin(bb);
  try {
    expect(await harness.behavior.callRpc("query", { view: "status", hostId: "picked-host" })).toEqual(report);
    expect(harness.experimental_hostRpcCalls.at(-1)?.hostId).toBe("picked-host");
    const cli = await harness.behavior.runCli(["days", "--json"], { threadId: "thread-test", signal: new AbortController().signal });
    expect(cli.exitCode).toBe(0); expect(harness.experimental_hostRpcCalls.at(-1)?.hostId).toBe("thread-host");
    await harness.behavior.callAgentTool("trails_query", { view: "status" }, { threadId: "thread-test" });
    expect(harness.experimental_hostRpcCalls.at(-1)?.hostId).toBe("thread-host");
    await harness.behavior.setSettings({ serverUrl: "https://example.ts.net/" });
    await harness.behavior.callRpc("query", { view: "days" });
    expect(harness.experimental_hostRpcCalls.at(-1)?.input).toMatchObject({ serverUrl: "https://example.ts.net/" });
    await expect(harness.behavior.setSettings({ serverUrl: "http://example.com/" })).rejects.toThrow();
    await expect(harness.behavior.callRpc("query", { limit: 999 })).rejects.toThrow();
  } finally { await harness.lifecycle.dispose(); }
});
test("requires a machine outside a thread when multiple machines are enrolled", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", sdk: { hosts: { list: async () => [makeHostResponse({ id: "one" }), makeHostResponse({ id: "two" })] } }, experimental_callHostRpc: async () => report });
  plugin(bb);
  try {
    expect((await harness.behavior.runCli(["status"])).stderr).toContain("Choose a machine");
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
    expect((await harness.behavior.runCli(["status", "--machine", "two"])).exitCode).toBe(0);
  } finally { await harness.lifecycle.dispose(); }
});
test("disposal cancels active host work", async () => {
  let signal: AbortSignal | undefined;
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", experimental_callHostRpc: async args => { signal = args.signal; return report; } });
  plugin(bb);
  await harness.behavior.callRpc("query", { hostId: "one" });
  await harness.lifecycle.dispose();
  expect(signal?.aborted).toBe(true);
});
test("CLI rejects malformed arguments instead of silently querying", () => {
  for (const args of [["days", "--limit", "1.5"], ["days", "--limit", "21"], ["days", "--offset", "-1"], ["days", "--machine"], ["status", "--date", "2026-09-16"], ["days", "--unknown"], ["days", "--limit", "1", "--limit", "2"]]) expect(() => parseArgs(args)).toThrow();
});
test("uses only public SDK and package-local imports", () => {
  const scan = experimental_scanPublicSdkOnly(import.meta.dir, { allow: [/^bun:test$/, /^react$/, /^@radix-ui\/react-slot$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^@testing-library\/react$/, /^@happy-dom\/global-registrator$/] });
  expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
});

test("thread queries resolve repository checkouts and machine on the server and reject scope overrides", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", settings: { machine: "wrong-default" }, sdk: {
    threads: { get: async () => makeThreadResponse({ projectId: "repo", environmentId: "worktree" }) },
    projects: { get: async () => ({ id: "repo", kind: "standard", name: "Trails", sources: [{ path: "/Users/example/code/trails" }] }) as never },
    environments: {
      get: async () => ({ projectId: "repo", hostId: "thread-host", path: "/worktrees/feature" }) as never,
      list: async () => [{ projectId: "repo", path: "/worktrees/other" }, { projectId: "unrelated", path: "/private/other" }] as never,
    },
  }, experimental_callHostRpc: async () => report });
  plugin(bb);
  try {
    expect(await harness.behavior.callRpc("threadQuery", { threadId: "thread" })).toEqual({ repository: "Trails", report });
    const call = harness.experimental_hostRpcCalls.at(-1)!;
    expect(call.hostId).toBe("thread-host");
    expect(call.input).toMatchObject({ view: "days", repoPaths: ["/Users/example/code/trails", "/worktrees/other", "/worktrees/feature"] });
    for (const override of [{ hostId: "elsewhere" }, { project: "other" }, { repoPaths: ["/"] }, { view: "status" }]) {
      await expect(harness.behavior.callRpc("threadQuery", { threadId: "thread", ...override })).rejects.toThrow();
    }
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
  } finally { await harness.lifecycle.dispose(); }
});

test("projectless threads cannot fetch global activity through the repository panel", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", sdk: {
    threads: { get: async () => makeThreadResponse({ projectId: "personal" }) },
    projects: { get: async () => ({ id: "personal", kind: "personal" }) as never },
  } });
  plugin(bb);
  try {
    await expect(harness.behavior.callRpc("threadQuery", { threadId: "thread" })).rejects.toThrow("project thread");
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);
  } finally { await harness.lifecycle.dispose(); }
});

test("CLI sanitizes reports and hosts while JSON, RPC and agent data retain original strings", async () => {
  const attack = "\x1b[2J\x1b]52;c;Y2xpcGJvYXJk\x07\x1b]8;;https://example.invalid\x1b\\\x1b]8;;\x1b\\\x1bPhidden\x1b\\\x9b31m\x9dhidden\x9c\x08\x7f\u202e";
  const session = { id: "session", source: attack + "codex", machine: attack + "Mini", branch: null, start: "start", end: attack + "end", firstPrompt: attack + "prompt", summary: null };
  const malicious = reportSchema.parse({ ...report, total: 1, fetchedAt: attack + report.fetchedAt, warnings: [attack + "warning"],
    days: [{ date: attack + "date", focusMinutes: 10, sessionCount: 1, sessions: [], projectCount: 1, projects: [{ path: attack + "/project", name: attack + "Project", focusMinutes: 10, sessionCount: 1, summary: attack + "day summary" }] }],
    projects: [{ path: attack + "/project", name: attack + "Project", focusMinutes: 10, sessionCount: 2, latestAt: "end", sessions: [session, { ...session, id: "summary-session", summary: attack + "session summary" }] }],
    machines: [{ name: attack + "Mini", lastCheckedAt: attack + "today", lastIngestedAt: null, lastProcessedAt: null, lastError: attack + "error" }],
    summaries: { selection: attack + "auto", harness: "codex", state: attack + "ok", lastSuccessAt: null, lastErrorClass: null },
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", settings: { machine: "host" }, sdk: { threads: { get: async () => makeThreadResponse({ environmentId: null }) }, hosts: { list: async () => [makeHostResponse({ id: "host", name: attack + "Mini" })] } }, experimental_callHostRpc: async () => malicious });
  plugin(bb);
  try {
    const original = JSON.stringify(malicious);
    for (const view of ["days", "projects", "status"] as const) {
      const plain = await harness.behavior.runCli([view]);
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout!.replaceAll("\n", "")).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
      expect(plain.stdout).not.toContain("hidden");
      expect(plain.stdout).not.toContain("example.invalid");
      expect(plain.stdout).toContain(view === "days" ? "day summary" : view === "projects" ? "session summary" : "error");
      if (view === "projects") expect(plain.stdout).toContain("prompt");
      const json = await harness.behavior.runCli([view, "--json"]);
      expect(JSON.parse(json.stdout!)).toEqual(malicious);
    }
    expect((await harness.behavior.runCli(["hosts"])).stdout).toBe("host  Mini");
    expect(JSON.parse((await harness.behavior.runCli(["hosts", "--json"])).stdout!).hosts[0].name).toBe(attack + "Mini");
    expect(await harness.behavior.callRpc("query", { view: "days" })).toEqual(malicious);
    expect(await harness.behavior.callAgentTool("trails_query", { view: "days" })).toBe(original);
    expect(JSON.stringify(malicious)).toBe(original);
  } finally { await harness.lifecycle.dispose(); }
});

test("CLI sanitizes upstream errors", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "trails", settings: { machine: "host" }, experimental_callHostRpc: async () => { throw new Error("upstream\x1b[2J\x1b]52;c;hidden\x07\u202efailure"); } });
  plugin(bb);
  try {
    const result = await harness.behavior.runCli(["status"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("upstreamfailure");
    expect(result.stderr).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202e]/);
  } finally { await harness.lifecycle.dispose(); }
});
