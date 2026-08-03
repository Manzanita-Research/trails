export {}

const children = [
  Bun.spawn(["bun", "x", "vite"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--watch", "cli/main.ts", "serve", "--port", "7413", "--api-only"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
]

let stopping = false
const stopChildren = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill()
}
process.once("SIGINT", stopChildren)
process.once("SIGTERM", stopChildren)

const exitCode = await Promise.race(children.map((child) => child.exited))
stopChildren()
await Promise.allSettled(children.map((child) => child.exited))
process.exitCode = exitCode
