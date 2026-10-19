| One run | celld dev --no-watch (Route A) | workerd (Route C) |
|---|---|---|
| Serves the bundle alchemy builds, unchanged | **no**: celld did not answer /health within 20 s | yes |
| … with only the terminal shim | **no**: Operation timed out after '20s' | n/a |
| Runtime | celld 0.6.2 | workerd 2026-09-18 |
| Works, full run (bundle with the shims) | yes | yes |
| Cold start to first answer | 449 ms | 208 ms |
| Register (2 policies, a view, WebSocket push), p50 | 154 ms | 33.1 ms |
| Transfer through the saga to a pushed status, p50 | 283 ms | 43.7 ms |
| **Command latency, p50** (sequential) | 38 ms | 13.1 ms |
| **Command latency, p95** (sequential) | 433 ms | 17.9 ms |
| Command latency, p99 (sequential) | 920 ms | 21.2 ms |
| Under load (8 concurrent), p50 | 62.5 ms | 53.2 ms |
| Under load (8 concurrent), p95 | 3380 ms | 66.5 ms |
| Under load, commands per second | 13.3/s | 148.9/s |
| `watch` push over the WebSocket after a command, p50 | 94.9 ms | 6.9 ms |
| **Resident memory, idle** | 245 MiB | 135 MiB |
| **Resident memory, under load** (peak) | 357 MiB | 229 MiB |
| **Clean restart**: state survives, export byte-identical | yes | yes |
| Clean restart: SIGTERM to exit | 1564 ms | 22.4 ms |
| Clean restart: back up and answering | 1546 ms | 107 ms |
| **`kill -9` mid-command**: acknowledged commands lost | 0/150 | 0/153 |
| `kill -9`: log consistent, and in-flight retries land exactly once | yes | yes |
| `kill -9`: views catch up with no new command (within 90 s) | **no** | yes |
| `kill -9`: accounts whose views waited for their next command | 9 of 10 | 0 of 10 |
| `kill -9`: back up and answering | 14733 ms | 97.5 ms |
| **Export** every stream from sequence 0: consistent | yes | yes |
| Export: time for all streams (34 streams, ~906 events) | 65.4 ms | 27 ms |
| State on disk while running | 274 MiB | 237 MiB |
| State on disk after a clean stop | 121 MiB | 237 MiB |
