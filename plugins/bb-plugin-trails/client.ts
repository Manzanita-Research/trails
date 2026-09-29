import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Query, Report } from "./contract";

export function normalizeServerUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("Trails server must be a valid base URL"); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Trails server must be a credential-free base URL with path /");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("Trails server requires HTTPS except on loopback");
  }
  return url.toString();
}

export async function resolveServer(serverUrl: string, home = homedir()): Promise<{ url: string; source: Report["source"] }> {
  if (serverUrl.trim()) return { url: normalizeServerUrl(serverUrl), source: "plugin setting" };
  let content: string;
  try { content = await readFile(join(home, ".config/trails/collector.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { url: "http://127.0.0.1:7412/", source: "local hub" };
    throw new Error("Cannot read Trails collector configuration on this machine");
  }
  try {
    const config = z.object({ protocolVersion: z.literal(1), server: z.string() }).parse(JSON.parse(content));
    return { url: normalizeServerUrl(config.server), source: "Trails collector" };
  } catch { throw new Error("Invalid Trails collector configuration on this machine"); }
}

const sessionSchema = z.object({
  id: z.string(), source: z.string(), machine: z.object({ name: z.string() }),
  cwd: z.string().nullable(), branch: z.string().nullable(), start: z.string(), end: z.string(),
  firstPrompt: z.string().nullable(),
  activity: z.array(z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.number().int().min(0).max(1439), z.number().nonnegative(), z.number().nonnegative()])),
});
const bootstrapSchema = z.object({
  protocolVersion: z.literal(1), revision: z.number(), timezone: z.string(),
  sessions: z.array(sessionSchema),
  summaries: z.object({ days: z.record(z.string(), z.string()), sessions: z.record(z.string(), z.string()) }),
  preferences: z.object({ boundary: z.union([z.literal(4), z.literal(5), z.literal(6), z.literal(7)]),
    halo: z.union([z.literal(0), z.literal(5), z.literal(10), z.literal(15)]), names: z.record(z.string(), z.string()) }),
});
const machinesSchema = z.object({ protocolVersion: z.literal(1), machines: z.array(z.object({
  name: z.string(), lastCheckedAt: z.string().nullable(), lastIngestedAt: z.string().nullable(),
  lastProcessedAt: z.string().nullable(), lastError: z.string().nullable(),
})) });
const harnessSchema = z.object({ protocolVersion: z.literal(1), active: z.object({
  selection: z.string(), harness: z.string().nullable(), state: z.string(),
  lastSuccessAt: z.number().nullable(), lastErrorClass: z.string().nullable(),
}).nullable() });
type Session = z.infer<typeof sessionSchema>;
const clip = (value: string) => value.length > 2048 ? `${value.slice(0, 2047)}…` : value;
const nullable = (value: string | null | undefined) => value == null ? null : clip(value);
export function projectPath(cwd: string | null): string {
  return (cwd ?? "(unknown)").replace(/^\/Users\/[^/]+\//, "").split("/.claude/worktrees/")[0];
}
function workday(date: string, minute: number, boundary: number) {
  if (minute >= boundary * 60) return { date, minute };
  const previous = new Date(`${date}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return { date: previous.toISOString().slice(0, 10), minute: minute + 1440 };
}
export function focusMinutes(minutes: Set<number>, halo: number): number {
  const sorted = [...minutes].sort((a, b) => a - b);
  let total = 0, end = -Infinity;
  for (const minute of sorted) {
    const start = Math.max(minute - halo, end + 1);
    total += Math.max(0, minute + halo - start + 1);
    end = Math.max(end, minute + halo);
  }
  return total;
}
export function buildReport(value: unknown, query: Query, source: Report["source"], now = new Date(), repoPaths?: string[]): Report {
  const bootstrap = bootstrapSchema.parse(value);
  const repositoryPaths = repoPaths?.map(path => projectPath(path.replace(/\/+$/, "")));
  type Activity = { minutes: Set<number>; sessions: Set<string> };
  const days = new Map<string, Map<string, Activity>>();
  const projects = new Map<string, Session[]>();
  for (const session of bootstrap.sessions) {
    const path = projectPath(session.cwd);
    if (repositoryPaths && !repositoryPaths.some(root => path === root || path.startsWith(`${root}/`))) continue;
    if (query.project && path !== query.project) continue;
    let included = !query.date;
    for (const [date, minute, , userEvents] of session.activity) {
      const day = workday(date, minute, bootstrap.preferences.boundary);
      if (query.date && day.date !== query.date) continue;
      included = true;
      let projectMap = days.get(day.date);
      if (!projectMap) days.set(day.date, projectMap = new Map());
      let activity = projectMap.get(path);
      if (!activity) projectMap.set(path, activity = { minutes: new Set(), sessions: new Set() });
      activity.sessions.add(session.id);
      if (userEvents > 0) activity.minutes.add(day.minute);
    }
    if (included) {
      const sessions = projects.get(path) ?? [];
      sessions.push(session);
      projects.set(path, sessions);
    }
  }
  const name = (path: string) => clip(bootstrap.preferences.names[path] ?? path.split("/").filter(Boolean).at(-1) ?? path);
  const halo = bootstrap.preferences.halo;
  const dayRows = [...days].sort(([a], [b]) => b.localeCompare(a));
  const projectRows = [...projects].map(([path, sessions]) => ({ path, sessions: sessions.sort((a, b) => b.end.localeCompare(a.end)) }))
    .sort((a, b) => b.sessions[0].end.localeCompare(a.sessions[0].end) || a.path.localeCompare(b.path));
  const sessionRow = (session: Session) => ({
    id: clip(session.id), source: clip(session.source), machine: clip(session.machine.name), branch: nullable(session.branch),
    start: clip(session.start), end: clip(session.end), firstPrompt: nullable(session.firstPrompt),
    summary: nullable(bootstrap.summaries.sessions[session.id]),
  });
  const scopedSessions = repoPaths ? projectRows.flatMap(project => project.sessions).sort((a, b) => b.end.localeCompare(a.end)) : [];
  const total = query.view === "days" ? dayRows.length : projectRows.length;
  const report = emptyReport(source, now);
  report.revision = bootstrap.revision;
  report.timezone = bootstrap.timezone;
  report.total = total;
  report.nextOffset = query.offset + query.limit < total ? query.offset + query.limit : null;
  if (query.view === "days") report.days = dayRows.slice(query.offset, query.offset + query.limit).map(([date, map]) => ({
    date,
    focusMinutes: focusMinutes(new Set([...map.values()].flatMap(activity => [...activity.minutes])), halo),
    sessionCount: new Set([...map.values()].flatMap(activity => [...activity.sessions])).size,
    sessions: scopedSessions.filter(session => map.get(projectPath(session.cwd))?.sessions.has(session.id)).slice(0, 10).map(sessionRow),
    projectCount: map.size,
    projects: [...map].map(([path, activity]) => ({ path: clip(path), name: name(path),
      summary: nullable(bootstrap.summaries.days[`${date}|${path}`]),
      focusMinutes: focusMinutes(activity.minutes, halo), sessionCount: activity.sessions.size,
    })).sort((a, b) => b.focusMinutes - a.focusMinutes || a.path.localeCompare(b.path)).slice(0, 30),
  }));
  if (query.view === "projects") report.projects = projectRows.slice(query.offset, query.offset + query.limit).map(({ path, sessions }) => ({
    path: clip(path), name: name(path), sessionCount: sessions.length, latestAt: clip(sessions[0].end),
    focusMinutes: [...days.values()].reduce((sum, map) => sum + focusMinutes(map.get(path)?.minutes ?? new Set(), halo), 0),
    sessions: sessions.slice(0, 10).map(sessionRow),
  }));
  return report;
}
function emptyReport(source: Report["source"], now = new Date()): Report {
  return { source, fetchedAt: now.toISOString(), timezone: null, revision: null, total: 0, nextOffset: null,
    warnings: [], days: [], projects: [], machines: [], summaries: null };
}

export async function requestJson(base: string, path: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const response = await fetcher(new URL(path, base), {
    method: "GET", redirect: "error", headers: { Accept: "application/json" }, cache: "no-store", signal,
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty Trails response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 32 * 1024 * 1024) throw new Error("Trails response exceeds 32 MiB");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function queryTrails(query: Query, serverUrl: string, signal: AbortSignal, options: { home?: string; fetch?: typeof fetch; repoPaths?: string[] } = {}): Promise<Report> {
  signal.throwIfAborted();
  const connection = await resolveServer(serverUrl, options.home);
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const read = (path: string) => requestJson(connection.url, path, boundedSignal, options.fetch);
  try {
    if (query.view !== "status") {
      const value = await read("/api/bootstrap");
      signal.throwIfAborted();
      return buildReport(value, query, connection.source, new Date(), options.repoPaths);
    }
    const report = emptyReport(connection.source);
    const results = await Promise.allSettled([read("/api/machines").then(value => machinesSchema.parse(value)), read("/api/harnesses").then(value => harnessSchema.parse(value))]);
    if (results.every(result => result.status === "rejected")) throw new Error("Health endpoints unavailable");
    const [machines, harness] = results;
    if (machines.status === "fulfilled") {
      report.machines = machines.value.machines.slice(0, 100).map(machine => ({
        name: clip(machine.name), lastCheckedAt: nullable(machine.lastCheckedAt), lastIngestedAt: nullable(machine.lastIngestedAt),
        lastProcessedAt: nullable(machine.lastProcessedAt), lastError: nullable(machine.lastError),
      }));
      if (machines.value.machines.length > 100) report.warnings.push("Showing the first 100 collectors");
    } else report.warnings.push("Collector status unavailable");
    if (harness.status === "fulfilled") {
      const active = harness.value.active;
      report.summaries = active ? { selection: clip(active.selection), harness: nullable(active.harness), state: clip(active.state),
        lastSuccessAt: active.lastSuccessAt, lastErrorClass: nullable(active.lastErrorClass) } : null;
    } else report.warnings.push("Summary status unavailable");
    signal.throwIfAborted();
    return report;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof z.ZodError) throw new Error("Trails returned incompatible data. Check the Trails version on the hub.");
    // Do not leak URLs, response bodies, or configuration through error messages.
    throw new Error("Trails is unavailable. Check that the hub is running and this machine can reach it; reconnect Tailscale if needed.");
  }
}
