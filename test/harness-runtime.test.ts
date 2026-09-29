import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runHarnessProcess, type HarnessProcessRequest } from "../server/harnesses/runtime"

const descriptor = await open(import.meta.path, "r")
const filePrototype = Object.getPrototypeOf(descriptor) as FileHandle
await descriptor.close()

const CAP = 1024 * 1024
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(script = "", overrides: Partial<HarnessProcessRequest> = {}) {
  const root = mkdtempSync(join(tmpdir(), "trails-harness-output-"))
  roots.push(root)
  const scriptPath = join(root, "child.js")
  writeFileSync(scriptPath, script)
  return {
    root,
    request: {
      executable: process.execPath,
      args: [scriptPath],
      cwd: root,
      stdin: null,
      outputPath: null,
      timeoutMs: 10_000,
      ...overrides,
    } satisfies HarnessProcessRequest,
  }
}

function expectExited(pidPath: string) {
  const pid = Number(readFileSync(pidPath, "utf8"))
  expect(() => process.kill(pid, 0)).toThrow()
}

describe("harness output files", () => {
  test("accepts a regular file exactly at the byte cap and decodes UTF-8", async () => {
    const { root, request } = fixture()
    const outputPath = join(root, "output")
    const text = "é".repeat(CAP / 2)
    writeFileSync(outputPath, text)
    const result = await runHarnessProcess({ ...request, outputPath })
    expect(result.output).toBe(text)
    expect(result.timedOut).toBe(false)
  })

  test("rejects an oversized sparse file before opening a read stream", async () => {
    const { root, request } = fixture()
    const outputPath = join(root, "output")
    writeFileSync(outputPath, "")
    truncateSync(outputPath, 2 ** 32)
    const stream = spyOn(filePrototype, "createReadStream")
    try {
      await expect(runHarnessProcess({ ...request, outputPath })).rejects.toThrow("protocol")
      expect(stream).not.toHaveBeenCalled()
    } finally {
      stream.mockRestore()
    }
  })

  test("rejects growth after stat using the actual byte count", async () => {
    const { root, request } = fixture()
    const outputPath = join(root, "output")
    writeFileSync(outputPath, "initial")
    const original = filePrototype.createReadStream
    const stream = spyOn(filePrototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
      truncateSync(outputPath, CAP + 1)
      return original.call(this, options)
    })
    try {
      await expect(runHarnessProcess({ ...request, outputPath })).rejects.toThrow("protocol")
    } finally {
      stream.mockRestore()
    }
  })

  for (const kind of ["fifo", "symlink", "directory"] as const) {
    test(`rejects a ${kind} output path promptly`, async () => {
      const { root, request } = fixture()
      const outputPath = join(root, "output")
      if (kind === "fifo") {
        expect(Bun.spawnSync(["/usr/bin/mkfifo", outputPath]).exitCode).toBe(0)
      } else if (kind === "symlink") {
        const target = join(root, "target")
        writeFileSync(target, "must not read")
        symlinkSync(target, outputPath)
      } else {
        mkdirSync(outputPath)
      }
      const started = performance.now()
      await expect(runHarnessProcess({ ...request, outputPath })).rejects.toThrow()
      expect(performance.now() - started).toBeLessThan(2_500)
    })
  }

  test("preserves nonzero exit diagnostics when the output file is missing", async () => {
    const { root, request } = fixture('console.error("please login"); process.exit(1)')
    const result = await runHarnessProcess({ ...request, outputPath: join(root, "missing") })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("please login")
    expect(result.output).toBeNull()
  })
})

describe("harness output lifetime", () => {
  test("accepts both pipes exactly at their independent byte caps", async () => {
    const { request } = fixture(`
      process.stdout.write("é".repeat(${CAP / 2}));
      process.stderr.write("x".repeat(${CAP}));
    `)
    const result = await runHarnessProcess(request)
    expect(result.stdout).toBe("é".repeat(CAP / 2))
    expect(result.stderr).toBe("x".repeat(CAP))
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  for (const interruption of ["timeout", "cancellation"] as const) {
    test(`${interruption} bounds a stalled output read and closes its descriptor`, async () => {
      const { root, request } = fixture()
      const outputPath = join(root, "output")
      writeFileSync(outputPath, "summary")
      const controller = new AbortController()
      const original = filePrototype.createReadStream
      let outputStream: ReturnType<FileHandle["createReadStream"]> | undefined
      let closed: Promise<void> | undefined
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const stream = spyOn(filePrototype, "createReadStream").mockImplementation(function (this: FileHandle, options) {
        const result = original.call(this, options)
        // Hold the descriptor open with a read that produces no data. The real
        // stream's abort/destroy and descriptor cleanup still run.
        result._read = () => {}
        outputStream = result
        closed = new Promise((resolve) => result.once("close", resolve))
        if (interruption === "cancellation") {
          cancelTimer = setTimeout(() => controller.abort(new Error("canceled read")), 10)
        }
        return result
      })
      const started = performance.now()
      try {
        const running = runHarnessProcess({ ...request, outputPath, signal: controller.signal, timeoutMs: 500 })
        if (interruption === "timeout") {
          expect((await running).timedOut).toBe(true)
        } else {
          await expect(running).rejects.toThrow("canceled read")
        }
        expect(outputStream).toBeDefined()
        await closed
        expect(outputStream!.destroyed).toBe(true)
        expect(outputStream!.closed).toBe(true)
        expect(performance.now() - started).toBeLessThan(2_500)
      } finally {
        clearTimeout(cancelTimer)
        stream.mockRestore()
      }
    })
  }

  for (const pipe of ["stdout", "stderr"] as const) {
    test(`terminates a child that keeps running after ${pipe} overflow`, async () => {
      const { root, request } = fixture(`
        import { writeFileSync } from "node:fs";
        writeFileSync(process.env.TMPDIR + "/pid", String(process.pid));
        process.on("SIGTERM", () => {});
        process.${pipe}.write("x".repeat(${CAP + 1}));
        setInterval(() => {}, 1000);
      `)
      const started = performance.now()
      await expect(runHarnessProcess(request)).rejects.toThrow("protocol")
      expect(performance.now() - started).toBeLessThan(3_000)
      expectExited(join(root, "pid"))
    })
  }

  test("timeout terminates a quiet child and skips its output file", async () => {
    const { root, request } = fixture(`
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.TMPDIR + "/pid", String(process.pid));
      setInterval(() => {}, 1000);
    `)
    const started = performance.now()
    const result = await runHarnessProcess({ ...request, timeoutMs: 250, outputPath: join(root, "missing") })
    expect(result.timedOut).toBe(true)
    expect(result.output).toBeNull()
    expect(performance.now() - started).toBeLessThan(2_500)
    expectExited(join(root, "pid"))
  })

  test("cancellation terminates a running child", async () => {
    const { root, request } = fixture(`
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.TMPDIR + "/pid", String(process.pid));
      setInterval(() => {}, 1000);
    `)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error("canceled")), 250)
    try {
      await expect(runHarnessProcess({ ...request, signal: controller.signal })).rejects.toThrow("canceled")
      expectExited(join(root, "pid"))
    } finally {
      clearTimeout(timer)
    }
  })

  test("an already canceled request does not spawn", async () => {
    const { root, request } = fixture('await Bun.write(process.env.TMPDIR + "/started", "yes")')
    const controller = new AbortController()
    controller.abort(new Error("already canceled"))
    await expect(runHarnessProcess({ ...request, signal: controller.signal })).rejects.toThrow("already canceled")
    expect(existsSync(join(root, "started"))).toBe(false)
  })
})
