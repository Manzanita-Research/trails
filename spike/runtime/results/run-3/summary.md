| One run | celld dev --no-watch (Route A) | workerd (Route C) |
|---|---|---|
| Serves the bundle alchemy builds, unchanged | **no**: celld did not answer /health within 20 s | yes |
| … with only the terminal shim | **no**: Operation timed out after '20s' | n/a |
| Runtime | celld 0.6.2 | workerd 2026-09-18 |
| Works, full run (bundle with the shims) | yes | yes |
| Cold start to first answer | 426 ms | 206 ms |
| Register (2 policies, a view, WebSocket push), p50 | 160 ms | 32.8 ms |
| Transfer through the saga to a pushed status, p50 | 443 ms | 43.8 ms |
| **Command latency, p50** (sequential) | 41 ms | 13.1 ms |
| **Command latency, p95** (sequential) | 472 ms | 17.8 ms |
| Command latency, p99 (sequential) | 692 ms | 25.8 ms |
| Under load (8 concurrent), p50 | 61.7 ms | 55 ms |
| Under load (8 concurrent), p95 | 2701 ms | 70.6 ms |
| Under load, commands per second | 12.7/s | 142.5/s |
| `watch` push over the WebSocket after a command, p50 | 103 ms | 8 ms |
| **Resident memory, idle** | 238 MiB | 102 MiB |
| **Resident memory, under load** (peak) | 383 MiB | 211 MiB |
| **Clean restart**: state survives, export byte-identical | yes | yes |
| Clean restart: SIGTERM to exit | 1484 ms | 22.8 ms |
| Clean restart: back up and answering | 1295 ms | 128 ms |
| **`kill -9` mid-command**: acknowledged commands lost | 0/150 | 0/153 |
| `kill -9`: log consistent, and in-flight retries land exactly once | yes | yes |
| `kill -9`: views catch up with no new command (within 90 s) | **no** | yes |
| `kill -9`: accounts whose views waited for their next command | 10 of 10 | 0 of 10 |
| `kill -9`: back up and answering | 773 ms | 97.6 ms |
| **Export** every stream from sequence 0: consistent | yes | yes |
| Export: time for all streams (34 streams, ~906 events) | 50.2 ms | 32.3 ms |
| State on disk while running | 321 MiB | 237 MiB |
| State on disk after a clean stop | 126 MiB | 237 MiB |
