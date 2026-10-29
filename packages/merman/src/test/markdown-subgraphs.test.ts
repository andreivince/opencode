import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

test("keeps cyclic subgraph source visible without blocking Markdown rendering", async () => {
  // A layout cycle blocks synchronously, so contain a regression outside the test runner.
  const child = Bun.spawn({
    cmd: [process.execPath, fileURLToPath(new URL("./markdown-subgraphs.fixture.ts", import.meta.url))],
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5_000,
    killSignal: "SIGKILL",
  })
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(stderr).toBe("")
  expect(status).toBe(0)
  const result: {
    fresh: Array<{ source: string; frame: string }>
    acyclic: string
    streamed: { source: string; frames: string[] }
  } = JSON.parse(stdout)
  const sourceFrame = (frame: string) =>
    frame
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
  expect(result.fresh).toHaveLength(3)
  expect(result.streamed.frames).toHaveLength(4)
  for (const { source, frame } of result.fresh) {
    expect(sourceFrame(frame)).toContain(source)
    expect(frame).toContain("Before")
    expect(frame).toContain("After")
  }
  expect(result.acyclic).toContain("First")
  expect(result.acyclic).toContain("Second")
  expect(result.acyclic).not.toContain("flowchart LR")
  for (const frame of result.streamed.frames.slice(0, 2)) {
    expect(frame).toContain("Earlier")
    expect(frame).not.toContain("flowchart TD")
  }
  for (const frame of result.streamed.frames.slice(2)) {
    expect(sourceFrame(frame)).toContain(result.streamed.source)
    expect(frame).toContain("Before")
    expect(frame).toContain("After")
  }
})
