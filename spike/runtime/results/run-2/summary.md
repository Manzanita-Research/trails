| One run | celld dev --no-watch (Route A) | workerd (Route C) |
|---|---|---|
| Serves the bundle alchemy builds, unchanged | **no**: celld did not answer /health within 20 s | yes |
| … with only the terminal shim | **no**: Operation timed out after '20s' | n/a |
| Runtime | celld 0.6.2 | workerd 2026-09-18 |
| Works, full run (bundle with the shims) | yes | yes |
| Cold start to first answer | 422 ms | 223 ms |
| Register (2 policies, a view, WebSocket push), p50 | 190 ms | 43.5 ms |
| Transfer through the saga to a pushed status, p50 | 362 ms | 47.9 ms |
| **Command latency, p50** (sequential) | 34.4 ms | 13.3 ms |
| **Command latency, p95** (sequential) | 430 ms | 17.3 ms |
| Command latency, p99 (sequential) | 812 ms | 26.4 ms |
| Under load (8 concurrent), p50 | 77 ms | 52.2 ms |
| Under load (8 concurrent), p95 | 3151 ms | 71.7 ms |
| Under load, commands per second | 12.6/s | 148.3/s |
| `watch` push over the WebSocket after a command, p50 | 98.5 ms | 6.8 ms |
| **Resident memory, idle** | 242 MiB | 135 MiB |
| **Resident memory, under load** (peak) | 361 MiB | 229 MiB |
| **Clean restart**: state survives, export byte-identical | yes | yes |
| Clean restart: SIGTERM to exit | 1676 ms | 21.5 ms |
| Clean restart: back up and answering | 1225 ms | 108 ms |
| **`kill -9` mid-command**: acknowledged commands lost | 0/151 | 0/153 |
| `kill -9`: log consistent, and in-flight retries land exactly once | yes | yes |
| `kill -9`: views catch up with no new command (within 90 s) | **no** | yes |
| `kill -9`: accounts whose views waited for their next command | 7 of 10 | 0 of 10 |
| `kill -9`: back up and answering | 902 ms | 97.4 ms |
| **Export** every stream from sequence 0: consistent | yes | yes |
| Export: time for all streams (34 streams, ~906 events) | 111 ms | 44.6 ms |
| State on disk while running | 271 MiB | 237 MiB |
| State on disk after a clean stop | 118 MiB | 237 MiB |
