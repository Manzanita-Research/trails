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
