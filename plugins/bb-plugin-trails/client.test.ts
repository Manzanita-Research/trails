import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, focusMinutes, normalizeServerUrl, queryTrails, resolveServer, requestJson } from "./client";
import { querySchema, reportSchema } from "./contract";

import { fixture } from "./fixture";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("discovers configuration on the selected home without modifying it", async () => {
  const home = await mkdtemp(join(tmpdir(), "trails-bb-")); dirs.push(home);
  expect(await resolveServer("", home)).toEqual({ url: "http://127.0.0.1:7412/", source: "local hub" });
  await mkdir(join(home, ".config/trails"), { recursive: true });
  const path = join(home, ".config/trails/collector.json");
  const original = JSON.stringify({ protocolVersion: 1, server: "https://example.ts.net/", deviceId: "private" });
  await writeFile(path, original);
  expect((await resolveServer("", home)).source).toBe("Trails collector");
  expect((await resolveServer("http://localhost:7414/", home)).source).toBe("plugin setting");
  expect(await readFile(path, "utf8")).toBe(original);
  await writeFile(path, "bad data");
  await expect(resolveServer("", home)).rejects.toThrow("Invalid Trails collector configuration");
});
test("rejects credentials, redirects destinations, paths and remote HTTP at configuration boundary", () => {
  for (const value of ["https://user:secret@example.com/", "http://example.com/", "file:///tmp/data", "https://example.com/api", "https://example.com/?token=secret", "https://example.com/#private"]) expect(() => normalizeServerUrl(value)).toThrow();
  expect(normalizeServerUrl("http://[::1]:7412/")).toBe("http://[::1]:7412/");
});
test("merges attention across midnight and projects without double counting", () => {
  const report = buildReport(fixture, querySchema.parse({}), "local hub");
  const day = report.days.find(day => day.date === "2026-09-15")!;
  expect(day.focusMinutes).toBe(15);
  expect(day.sessionCount).toBe(2);
  expect(day.projects.find(project => project.name === "Trails")?.focusMinutes).toBe(15);
  expect(report.days[0].focusMinutes).toBe(0);
  expect(focusMinutes(new Set([1, 2, 3]), 0)).toBe(3);
  expect(reportSchema.safeParse(report).success).toBe(true);
});
test("filters and paginates with explicit totals; only projects safe fields", () => {
  const page = buildReport(fixture, querySchema.parse({ limit: 1 }), "local hub");
  expect(page.total).toBe(2); expect(page.nextOffset).toBe(1);
  expect(buildReport(fixture, querySchema.parse({ offset: 1 }), "local hub").days[0].date).toBe("2026-09-15");
  const result = buildReport(fixture, querySchema.parse({ view: "projects", date: "2026-09-15", project: "code/trails" }), "local hub");
  expect(result.projects[0].sessions[0].summary).toBe("Connected Trails to BB");
  expect(result.projects[0].focusMinutes).toBe(15);
  expect(result.total).toBe(1);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  expect(() => querySchema.parse({ date: "2026-02-31" })).toThrow();
});
test("caps session details and freeform text", () => {
  const large = { ...fixture, sessions: Array.from({ length: 15 }, (_, i) => ({ ...fixture.sessions[0], id: `s${i}`, firstPrompt: "a".repeat(10000) })) };
  const result = buildReport(large, querySchema.parse({ view: "projects" }), "local hub");
  expect(result.projects[0].sessionCount).toBe(15); expect(result.projects[0].sessions).toHaveLength(10);
  expect(result.projects[0].sessions[0].firstPrompt).toHaveLength(2048);
});
test("uses GET only and reports partial health independently", async () => {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname; requests.push(path);
    expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("error");
    if (path === "/api/machines") return Response.json({ protocolVersion: 1, machines: [] });
    return new Response("private error body", { status: 503 });
  }) as typeof fetch;
  const result = await queryTrails(querySchema.parse({ view: "status" }), "http://localhost:7414/", new AbortController().signal, { fetch: fetcher });
  expect(requests.sort()).toEqual(["/api/harnesses", "/api/machines"]);
  expect(result.warnings).toEqual(["Summary status unavailable"]);
  await expect(queryTrails(querySchema.parse({}), "http://localhost:7414/", new AbortController().signal, { fetch: fetcher })).rejects.toThrow("Trails is unavailable");
});
test("reads a real loopback server, rejects redirects, and propagates cancellation", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/api/bootstrap" ? Response.json(fixture) : Response.redirect("https://example.com/") });
  try {
    const base = `http://127.0.0.1:${server.port}/`;
    const result = await queryTrails(querySchema.parse({}), base, new AbortController().signal);
    expect(result.total).toBe(2);
    await expect(requestJson(base, "/redirect", new AbortController().signal)).rejects.toThrow();
    const controller = new AbortController(); controller.abort();
    await expect(queryTrails(querySchema.parse({}), base, controller.signal)).rejects.toThrow();
  } finally { server.stop(true); }
});

test("repository scope includes checkout subdirectories and known worktrees, excluding neighboring repos and their summaries", () => {
  const data = structuredClone(fixture);
  data.sessions.push({ ...data.sessions[0], id: "subdir", cwd: "/Users/example/code/trails/packages/ui" });
  data.sessions.push({ ...data.sessions[0], id: "neighbor", cwd: "/Users/example/code/trails-other" });
  data.sessions.push({ ...data.sessions[0], id: "worktree", cwd: "/Users/example/worktrees/feature" });
  const paths = ["/Users/example/code/trails/", "/Users/example/worktrees/feature"];
  const report = buildReport(data, querySchema.parse({ view: "projects" }), "local hub", new Date(), paths);
  expect(report.projects.flatMap(project => project.sessions.map(session => session.id)).sort()).toEqual(["s1", "subdir", "worktree"]);
  const days = buildReport(data, querySchema.parse({ view: "days" }), "local hub", new Date(), paths);
  expect(days.days[0].projects.find(project => project.path === "code/trails")?.summary).toBe("Built the plugin");
  expect(days.days[0].projects.find(project => project.path === "worktrees/feature")?.summary).toBeNull();
  expect(JSON.stringify(days)).not.toContain("Unrelated project summary");
  expect(days.days[0].sessionCount).toBe(3);
});

test("reads with a separate URL-bound credential and never returns its value", async () => {
  const home = await mkdtemp(join(tmpdir(), "trails-bb-auth-")); dirs.push(home);
  await mkdir(join(home, ".config/trails"), { recursive: true });
  const token = "r".repeat(43);
  await writeFile(join(home, ".config/trails/reader.json"), JSON.stringify({ server: "https://hub.example/", token }), { mode: 0o600 });
  let calls = 0;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(init?.redirect).toBe("error");
    return Response.json(fixture);
  }) as typeof fetch;
  const report = await queryTrails(querySchema.parse({}), "https://hub.example/", new AbortController().signal, { home, fetch: fetcher });
  expect(JSON.stringify(report)).not.toContain(token);
  await expect(queryTrails(querySchema.parse({}), "https://different.example/", new AbortController().signal, { home, fetch: fetcher })).rejects.toThrow("exact hub URL");
  expect(calls).toBe(1);
});
