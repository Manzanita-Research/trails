| Median of 3 runs (range) | celld dev --no-watch (Route A) | workerd (Route C) |
|---|---|---|
| Serves the bundle alchemy builds, unchanged | **no**: celld did not answer /health within 20 s | yes (3/3) |
| … with only the terminal shim | **no**: Operation timed out after '20s' | n/a |
| Runtime | celld 0.6.2 | workerd 2026-09-18 |
| Works, full run (bundle with the shims) | yes (3/3) | yes (3/3) |
| Cold start to first answer | 426 ms (422 ms–449 ms) | 208 ms (206 ms–223 ms) |
| Register (2 policies, a view, WebSocket push), p50 | 160 ms (154 ms–190 ms) | 33.1 ms (32.8 ms–43.5 ms) |
| Transfer through the saga to a pushed status, p50 | 362 ms (283 ms–443 ms) | 43.8 ms (43.7 ms–47.9 ms) |
| **Command latency, p50** (sequential) | 38 ms (34.4 ms–41 ms) | 13.1 ms (13.1 ms–13.3 ms) |
| **Command latency, p95** (sequential) | 433 ms (430 ms–472 ms) | 17.8 ms (17.3 ms–17.9 ms) |
| Command latency, p99 (sequential) | 812 ms (692 ms–920 ms) | 25.8 ms (21.2 ms–26.4 ms) |
| Under load (8 concurrent), p50 | 62.5 ms (61.7 ms–77 ms) | 53.2 ms (52.2 ms–55 ms) |
| Under load (8 concurrent), p95 | 3151 ms (2701 ms–3380 ms) | 70.6 ms (66.5 ms–71.7 ms) |
| Under load, commands per second | 12.7/s (12.6/s–13.3/s) | 148.3/s (142.5/s–148.9/s) |
| `watch` push over the WebSocket after a command, p50 | 98.5 ms (94.9 ms–103 ms) | 6.9 ms (6.8 ms–8 ms) |
| **Resident memory, idle** | 242 MiB (238 MiB–245 MiB) | 135 MiB (102 MiB–135 MiB) |
| **Resident memory, under load** (peak) | 361 MiB (357 MiB–383 MiB) | 229 MiB (211 MiB–229 MiB) |
| **Clean restart**: state survives, export byte-identical | yes (3/3) | yes (3/3) |
| Clean restart: SIGTERM to exit | 1564 ms (1484 ms–1676 ms) | 22.4 ms (21.5 ms–22.8 ms) |
| Clean restart: back up and answering | 1295 ms (1225 ms–1546 ms) | 108 ms (107 ms–128 ms) |
| **`kill -9` mid-command**: acknowledged commands lost | 0/150, 0/151, 0/150 | 0/153, 0/153, 0/153 |
| `kill -9`: log consistent, and in-flight retries land exactly once | yes (3/3) | yes (3/3) |
| `kill -9`: views catch up with no new command (within 90 s) | **no** | yes (3/3) |
| `kill -9`: accounts whose views waited for their next command | 9, 7, 10 of 10 | 0, 0, 0 of 10 |
| `kill -9`: back up and answering | 902 ms (773 ms–14733 ms) | 97.5 ms (97.4 ms–97.6 ms) |
| **Export** every stream from sequence 0: consistent | yes (3/3) | yes (3/3) |
| Export: time for all streams (34 streams, ~906 events) | 65.4 ms (50.2 ms–111 ms) | 32.3 ms (27 ms–44.6 ms) |
| State on disk while running | 274 MiB (271 MiB–321 MiB) | 237 MiB (237 MiB–237 MiB) |
| State on disk after a clean stop | 121 MiB (118 MiB–126 MiB) | 237 MiB (237 MiB–237 MiB) |
