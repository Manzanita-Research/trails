import { expect, test } from "bun:test"
import { join } from "node:path"

test("Vite preserves the browser authority and origin through the API proxy", async () => {
  // Run outside the UI preload so Vite has native Node timers and browser globals.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/dev-proxy.ts")], {
    stdout: "pipe", stderr: "pipe",
  })
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
  } finally {
    child.kill()
  }
})
