import { useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import type { rpcContract, Report } from "./contract";

const duration = (minutes: number) => minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
const timestamp = (value: string | null) => value ? new Date(value).toLocaleString() : "Never";
export function TrailsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]);
  const [hostId, setHostId] = useState("");
  const [view, setView] = useState<"days" | "projects" | "status">("days");
  const [offset, setOffset] = useState(0);
  const [project, setProject] = useState<string | undefined>();
  const [date, setDate] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hostsReady, setHostsReady] = useState(false);
  useEffect(() => {
    let active = true;
    rpc.call("hosts").then(result => {
      if (!active) return;
      setHosts(result.hosts); setHostId(current => current || result.defaultHostId || ""); setHostsReady(true);
    }, cause => { if (active) { setError(cause instanceof Error ? cause.message : "Cannot load machines"); setHostsReady(true); } });
    return () => { active = false; };
  }, [rpc, refresh]);
  useEffect(() => { setReport(null); setError(null); }, [hostId, view, offset, project, date]);
  useEffect(() => {
    if (!hostId) { setReport(null); setLoading(false); return; }
    let active = true, busy = false;
    const load = async () => {
      if (busy) return;
      busy = true; setLoading(true);
      try {
        const result = await rpc.call("query", { hostId, view, offset, limit: 7,
          ...(view !== "status" && project ? { project } : {}),
          ...(view !== "status" && date ? { date } : {}) });
        if (active) { setReport(result); setError(null); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Trails is unavailable"); }
      finally { busy = false; if (active) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, [rpc, hostId, view, offset, project, date, refresh]);
  function changeView(next: typeof view) { setView(next); setOffset(0); setProject(undefined); }
  return <div className="h-full min-h-0 flex-1 overflow-y-auto text-foreground">
    <div className="mx-auto w-full max-w-4xl space-y-5 px-4 py-5 md:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-xl font-semibold">Trails</h1><p className="text-sm text-muted-foreground">Where your days actually went.</p></div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <select aria-label="Machine" value={hostId} onChange={event => { setHostId(event.target.value); setOffset(0); }} className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm">
            <option value="">Choose a machine</option>{hosts.map(host => <option key={host.id} value={host.id}>{host.name}</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh</Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Trails views" className="flex gap-1">
          {(["days", "projects", "status"] as const).map(tab => <Button key={tab} variant="ghost" size="sm" aria-pressed={view === tab} onClick={() => changeView(tab)}>{tab === "days" ? "Days" : tab === "projects" ? "Projects" : "Status"}</Button>)}
        </nav>
        {view !== "status" && <div className="flex items-center gap-2"><input type="date" aria-label="Work date" value={date} onChange={event => { setDate(event.target.value); setOffset(0); }} className="max-w-full rounded border border-input bg-background px-2 py-1 text-sm" />{date && <Button variant="ghost" size="sm" onClick={() => { setDate(""); setOffset(0); }}>All dates</Button>}</div>}
      </div>
      {project && <div className="flex min-w-0 items-center gap-2 text-sm"><span className="min-w-0 break-all text-muted-foreground">{project}</span><Button size="sm" variant="ghost" onClick={() => { setProject(undefined); setOffset(0); }}>Clear</Button></div>}
      {error && <div role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}{report && <p className="mt-1">Showing the last successful refresh.</p>}</div>}
      {!hostId && <p role="status" className="py-10 text-center text-sm text-muted-foreground">{!hostsReady ? "Loading machines…" : hosts.length ? "Choose the machine with your Trails connection." : "Enroll a machine in BB to connect to Trails."}</p>}
      {hostId && loading && !report && <p role="status" className="py-10 text-center text-sm text-muted-foreground">Loading Trails…</p>}
      {report && <>
        {report.warnings.map(warning => <p role="status" key={warning} className="text-sm text-muted-foreground">{warning}</p>)}
        {view === "days" && report.days.map(day => <article key={day.date} className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3"><h2 className="font-medium">{new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", month: "long", day: "numeric", year: "numeric" })}</h2><span className="text-sm text-muted-foreground">{duration(day.focusMinutes)} attention · {day.sessionCount} {day.sessionCount === 1 ? "session" : "sessions"}</span></div>
          {day.summary && <p className="whitespace-pre-wrap break-words px-4 pt-3 text-sm">{day.summary}</p>}
          <ul className="divide-y divide-border px-4">{day.projects.map(item => <li key={item.path}><button className="flex w-full items-center justify-between gap-3 py-3 text-left text-sm hover:text-primary" onClick={() => { setProject(item.path); setDate(day.date); setView("projects"); setOffset(0); }}><span className="min-w-0 break-words">{item.name}</span><span className="shrink-0 text-muted-foreground">{duration(item.focusMinutes)}</span></button></li>)}</ul>
          {day.projectCount > day.projects.length && <p className="px-4 pb-3 text-xs text-muted-foreground">Showing {day.projects.length} of {day.projectCount} projects</p>}
        </article>)}
        {view === "projects" && report.projects.map(item => <article key={item.path} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap justify-between gap-2"><h2 className="font-medium">{item.name}</h2><span className="text-sm text-muted-foreground">{duration(item.focusMinutes)} attention · {item.sessionCount} {item.sessionCount === 1 ? "session" : "sessions"}</span></div>
          <p className="mt-1 break-all text-xs text-muted-foreground">{item.path}</p>
          <ul className="mt-3 divide-y divide-border">{item.sessions.map(session => <li key={session.id} className="space-y-1 py-3"><p className="break-words text-xs text-muted-foreground">{session.source} · {session.machine} · {timestamp(session.end)}{session.branch ? ` · ${session.branch}` : ""}</p><p className="whitespace-pre-wrap break-words text-sm">{session.summary ?? session.firstPrompt ?? "Session"}</p></li>)}</ul>
          {item.sessionCount > item.sessions.length && <p className="text-xs text-muted-foreground">Latest {item.sessions.length} sessions of {item.sessionCount}. Select a work date to narrow the list.</p>}
        </article>)}
        {view !== "status" && report.total === 0 && <p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No activity found for this selection.</p>}
        {view === "status" && <>
          <section className="rounded-lg border border-border bg-card p-4"><h2 className="font-medium">Collectors</h2><ul className="mt-2 divide-y divide-border">{report.machines.map((machine, index) => <li key={index} className="space-y-1 py-3 text-sm"><p className="font-medium">{machine.name}</p><p className="text-muted-foreground">Checked {timestamp(machine.lastCheckedAt)}</p><p className="text-muted-foreground">Collected {timestamp(machine.lastIngestedAt)}</p><p className="text-muted-foreground">Processed {timestamp(machine.lastProcessedAt)}</p>{machine.lastError && <p className="break-words text-destructive">{machine.lastError}</p>}</li>)}</ul>{!report.machines.length && <p className="mt-2 text-sm text-muted-foreground">No collectors reported.</p>}</section>
          <section className="space-y-2 rounded-lg border border-border bg-card p-4"><h2 className="font-medium">Summaries</h2><p className="text-sm">{report.summaries ? `${report.summaries.selection} · ${report.summaries.state}` : report.warnings.includes("Summary status unavailable") ? "Unavailable" : "Off"}</p>{report.summaries?.lastSuccessAt && <p className="text-sm text-muted-foreground">Last success {timestamp(new Date(report.summaries.lastSuccessAt).toISOString())}</p>}{report.summaries?.lastErrorClass && <p className="text-sm text-destructive">{report.summaries.lastErrorClass}</p>}</section>
        </>}
        {view !== "status" && (offset > 0 || report.nextOffset !== null) && <div className="flex items-center justify-between"><Button variant="outline" size="sm" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - 7))}>Previous</Button><span className="text-xs text-muted-foreground">{offset + 1}–{Math.min(offset + 7, report.total)} of {report.total}</span><Button variant="outline" size="sm" disabled={report.nextOffset === null || loading} onClick={() => setOffset(report.nextOffset!)}>Next</Button></div>}
        <p className="text-xs text-muted-foreground">Updated {timestamp(report.fetchedAt)}{report.timezone ? ` · Work dates in ${report.timezone}` : ""}</p>
      </>}
    </div>
  </div>;
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: "activity", title: "Trails", icon: "Clock", path: "activity", component: TrailsPage });
});
