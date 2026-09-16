# Trails for BB

Recent working days, project sessions, and collector health in BB's sidebar, CLI, and agents. The plugin reads an existing Trails hub through an enrolled BB machine.

## Development installation

From this directory:

```sh
npm ci --include=dev
bun run check
bun test
bb plugin build
bb plugin install . --yes
```

Open **Trails** in BB's sidebar and select the machine with your Trails connection. The plugin uses that machine's `~/.config/trails/collector.json`, or `http://127.0.0.1:7412/` if no collector configuration exists. The BB server and browser don't need direct access to the hub.

```sh
bb trails hosts
bb trails days --machine HOST_ID
bb trails projects --date 2026-09-16 --machine HOST_ID --json
bb trails status --machine HOST_ID
```

Commands and `trails_query` use the current thread's machine when available. Outside a thread, configure a default if more than one machine is enrolled:

```sh
bb plugin config trails set machine HOST_ID
bb plugin config trails set serverUrl https://your-hub.example.ts.net/
```

Leave `serverUrl` blank for discovery. Settings apply to the next query without reload. The override is accessed from the selected machine. Credentials, query strings, URL fragments, non-root paths, and remote plain HTTP are rejected.

## Behavior and privacy

Days honor the hub's workday boundary and timezone. Attention minutes merge overlapping user activity using the configured halo. Click a project to inspect its sessions for that work date. Projects include their latest ten sessions; use the date filter for older activity. Pagination covers days and projects. Status shows collector timestamps and the summary harness's state. Visible pages refresh every 30 seconds; failed refreshes retain and label the last successful data.

This integration is read-only and does not install Trails, write its configuration, store a second activity database, or expose a public port. The existing hub remains canonical. Activity queries carry project paths, machine names, first prompts, and summaries through BB to the browser or agent conversation. They exclude source session identifiers, digests, transcript bodies, and capture payloads. Responses are projected through runtime schemas, text is capped, and CLI/tool results are bounded. Agents should query only activity relevant to the request.

HTTP calls use an eight-second timeout, reject redirects, and cap input at 32 MiB. Pages allow 1–20 rows, default seven; each day includes at most 30 projects and each project at most ten session details. Text fields are capped at 2,048 characters. Extremely large results require a narrower query. The full bootstrap is read per activity query because Trails does not currently provide a paginated read API.

## Verification

`bun test` covers configuration discovery, URL validation, workday rollover, overlapping attention, filters, pagination, response projection, failure isolation, cancellation, HTTP reads, host routing, live setting changes, RPC/tool/CLI boundaries, and disposal using BB's public SDK harness. `bun run check` validates all three entries; `bb plugin build` produces server, host, and app bundles.

The package is self-contained: it uses public BB SDK APIs and declares runtime dependencies. Generated bundles and `node_modules` stay untracked. It can be installed from this repository using `--subdirectory plugins/bb-plugin-trails`; it has not been published to a marketplace.
