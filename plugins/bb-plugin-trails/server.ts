import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, requestSchema, rpcContract, type Query, type Report } from "./contract";
import { normalizeServerUrl } from "./client";
export { rpcContract } from "./contract";

export const usage = `Usage:
  bb trails hosts [--json]
  bb trails days [--date YYYY-MM-DD] [--project PATH] [--limit 1-20] [--offset N] [--machine HOST_ID] [--json]
  bb trails projects [--date YYYY-MM-DD] [--project PATH] [--limit 1-20] [--offset N] [--machine HOST_ID] [--json]
  bb trails status [--machine HOST_ID] [--json]
Without --machine, commands use the thread's machine, then the configured machine,
or the only enrolled machine.`;
export function parseArgs(argv: string[]) {
  const [command = "help", ...args] = argv;
  if (!["days", "projects", "status", "hosts", "help", "--help"].includes(command)) throw new Error(usage);
  const values: Record<string, unknown> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") { json = true; continue; }
    const key = ({ "--date": "date", "--project": "project", "--limit": "limit", "--offset": "offset", "--machine": "hostId" } as Record<string, string>)[flag];
    const value = args[++i];
    if (!key || value === undefined || value.startsWith("--") || key in values) throw new Error(usage);
    values[key] = key === "limit" || key === "offset" ? (/^\d+$/.test(value) ? Number(value) : NaN) : value;
  }
  if (["hosts", "help", "--help"].includes(command)) {
    if (Object.keys(values).length) throw new Error(usage);
    return { command, json, query: null };
  }
  if (command === "status" && Object.keys(values).some(key => key !== "hostId")) throw new Error(usage);
  return { command, json, query: requestSchema.parse({ ...values, view: command }) };
}
const duration = (minutes: number) => `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
export function formatReport(report: Report, view: Query["view"]) {
  const lines = [`Trails · ${report.source} · fetched ${report.fetchedAt}`];
  if (view === "days") for (const day of report.days) {
    lines.push(`${day.date}  ${duration(day.focusMinutes)}  ${day.sessionCount} sessions`, ...day.projects.map(project => `  ${project.name}  ${duration(project.focusMinutes)}  ${project.path}${project.summary ? `\n  ${project.summary}` : ""}`));
    if (day.projectCount > day.projects.length) lines.push(`  Showing ${day.projects.length} of ${day.projectCount} projects`);
  }
  if (view === "projects") for (const project of report.projects) {
    lines.push(`${project.name}  ${duration(project.focusMinutes)}  ${project.sessionCount} sessions`, `  ${project.path}`);
    for (const session of project.sessions) lines.push(`  ${session.end} · ${session.source} · ${session.summary ?? session.firstPrompt ?? "Session"}`);
    if (project.sessionCount > project.sessions.length) lines.push(`  Showing the latest ${project.sessions.length} of ${project.sessionCount} sessions`);
  }
  if (view !== "status" && report.total === 0) lines.push("No activity found.");
  if (view === "status") {
    for (const machine of report.machines) lines.push(`${machine.name} · checked ${machine.lastCheckedAt ?? "never"} · ${machine.lastError ?? "no reported error"}`);
    if (!report.machines.length) lines.push("No collectors reported.");
    lines.push(`Summaries: ${report.summaries ? `${report.summaries.selection} · ${report.summaries.state}` : report.warnings.includes("Summary status unavailable") ? "unavailable" : "off"}`);
  }
  lines.push(...report.warnings);
  if (report.nextOffset !== null) lines.push(`More results: --offset ${report.nextOffset}`);
  return lines.join("\n");
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serverUrl: { type: "string", label: "Trails server URL (blank discovers the collector connection)", default: "",
      experimental_schema: z.string().max(2048).refine(value => { try { return !value.trim() || Boolean(normalizeServerUrl(value)); } catch { return false; } }, "Use an HTTPS base URL, or HTTP on loopback") },
    machine: { type: "string", label: "Default BB machine ID (optional)", default: "" },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());
  async function hosts() {
    const [machines, config] = await Promise.all([bb.sdk.hosts.list(), settings.get()]);
    const list = machines.map(machine => ({ id: machine.id, name: machine.name }));
    return { hosts: list, defaultHostId: list.find(machine => machine.id === config.machine)?.id ?? (list.length === 1 ? list[0].id : null) };
  }
  async function query(input: z.infer<typeof requestSchema>, threadId?: string, signal?: AbortSignal, repoPaths?: string[]): Promise<Report> {
    const { hostId: requested, ...query } = input;
    const config = await settings.get();
    let hostId = requested;
    if (!hostId && threadId) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.environmentId) hostId = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
    }
    hostId ||= config.machine || (await hosts()).defaultHostId || undefined;
    if (!hostId) throw new Error("Choose a machine in Trails, or run bb trails hosts and pass --machine HOST_ID.");
    const result = await host.call("query", { ...query, serverUrl: config.serverUrl, ...(repoPaths ? { repoPaths } : {}) }, {
      hostId, signal: signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal,
    });
    if (Buffer.byteLength(JSON.stringify(result)) > 800_000) throw new Error("Trails result is too large. Use a smaller --limit or a specific --date or --project.");
    return result;
  }
  bb.rpc.register(rpcContract, {
    hosts,
    query: input => query(input),
    async threadQuery({ threadId, ...input }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!thread.projectId) throw new Error("Open Trails in a project thread to see repository activity.");
      const project = await bb.sdk.projects.get({ projectId: thread.projectId });
      if (project.kind !== "standard") throw new Error("Open Trails in a project thread to see repository activity.");
      if (!thread.environmentId) throw new Error("This thread does not have a checkout yet.");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.projectId !== project.id) throw new Error("The thread checkout no longer belongs to this project.");
      const environments = await bb.sdk.environments.list({ projectId: project.id });
      const repoPaths = [...new Set([
        ...project.sources.map(source => source.path),
        ...environments.filter(item => item.projectId === project.id).map(item => item.path),
        environment.path,
      ].filter((path): path is string => Boolean(path)))];
      if (!repoPaths.length) throw new Error("This project has no checkout path to match in Trails.");
      const report = await query({ ...input, hostId: environment.hostId }, undefined, undefined, repoPaths);
      return { repository: project.name, report };
    },
  });
  bb.cli.register({
    name: "trails", summary: "Read Trails working days, project activity, and collector health",
    commands: [
      { name: "hosts", summary: "List BB machines", usage: "bb trails hosts [--json]" },
      ...(["days", "projects", "status"] as const).map(name => ({ name, summary: `Read Trails ${name}`, usage: `bb trails ${name} [--machine HOST_ID] [--json]${name === "status" ? "" : " [--date YYYY-MM-DD] [--project PATH] [--limit 1-20] [--offset N]"}` })),
    ],
    async run(argv, context) {
      try {
        const parsed = parseArgs(argv);
        if (parsed.command === "help" || parsed.command === "--help") return { exitCode: 0, stdout: usage };
        if (parsed.command === "hosts") {
          const result = await hosts();
          return { exitCode: 0, stdout: parsed.json ? JSON.stringify(result) : result.hosts.map(machine => `${machine.id}  ${machine.name}`).join("\n") || "No enrolled machines." };
        }
        const result = await query(parsed.query!, context.threadId, context.signal);
        return { exitCode: 0, stdout: parsed.json ? JSON.stringify(result) : formatReport(result, parsed.query!.view) };
      } catch (error) {
        return { exitCode: 1, stderr: error instanceof z.ZodError ? `Invalid Trails query.\n${usage}` : error instanceof Error ? error.message : "Trails query failed" };
      }
    },
  });
  bb.agents.registerTool({
    name: "trails_query",
    description: "Read Trails activity: recent working days, projects with latest session summaries, or collector and summary health. Filter by work date or exact project path; paginate with offset and limit. Uses the current thread's machine by default.",
    parameters: requestSchema,
    presentation: { label: { pending: "Reading Trails", completed: "Read Trails" } },
    async execute(input, context) { return JSON.stringify(await query(input, context.threadId, context.signal)); },
  });
}
