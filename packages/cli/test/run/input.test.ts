import { expect, test } from "bun:test"
import type { EventSubscribeOutput } from "@opencode/client/promise"
import path from "node:path"
import { OPENCODE_VERSION } from "../../src/version"
import { isolatedEnv } from "../fixture/environment"
import { tmpdir } from "../fixture/tmpdir"

type Prompt = { id: string; text: string }

test.each([
  { name: "one word", args: ["hello"], stdin: "", expected: "hello" },
  { name: "spaces", args: ["hello world"], stdin: "", expected: "hello world" },
  {
    name: "quotes, newlines, backslashes, and Unicode",
    args: ['Read "src/main.ts"\nKeep C:\\work\\file and café intact.'],
    stdin: "",
    expected: 'Read "src/main.ts"\nKeep C:\\work\\file and café intact.',
  },
  {
    name: "multiple arguments",
    args: ["compare", "first file", "second file"],
    stdin: "",
    expected: "compare first file second file",
  },
  { name: "whitespace", args: ["  keep  spaces\tand tabs\n"], stdin: "", expected: "  keep  spaces\tand tabs\n" },
  { name: "stdin", args: [], stdin: 'Read "this"\nverbatim', expected: 'Read "this"\nverbatim' },
  {
    name: "arguments and stdin",
    args: ["read this"],
    stdin: 'a "quoted" line',
    expected: 'read this\na "quoted" line',
  },
])("run preserves prompt text from $name", async ({ args, stdin, expected }) => {
  await using directory = await tmpdir()
  const prompts: Prompt[] = []
  const state: { stream?: ReadableStreamDefaultController<Uint8Array> } = {}
  const encoder = new TextEncoder()
  const send = (event: EventSubscribeOutput) =>
    state.stream?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/info")
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: directory.path } })
      if (url.pathname === "/api/location")
        return Response.json({ directory: directory.path, project: { id: "global", directory: directory.path } })
      if (url.pathname === "/api/session")
        return Response.json({ data: { id: "ses_input", location: { directory: directory.path } } })
      if (url.pathname === "/api/event")
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              state.stream = stream
              send({ id: "evt_connected", type: "server.connected", data: {} })
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      if (url.pathname === "/api/session/ses_input/prompt") {
        const prompt = (await request.json()) as Prompt
        prompts.push(prompt)
        send({
          id: "evt_delivered",
          created: 1,
          type: "session.inbox.delivered",
          durable: { aggregateID: "ses_input", seq: 1, version: 1 },
          data: { sessionID: "ses_input", inboxID: prompt.id },
        })
        send({
          id: "evt_succeeded",
          created: 2,
          type: "session.execution.succeeded",
          durable: { aggregateID: "ses_input", seq: 2, version: 1 },
          data: { sessionID: "ses_input" },
        })
        return Response.json({ data: prompt })
      }
      if (url.pathname === "/api/session/ses_input/permission" || url.pathname === "/api/session/ses_input/form")
        return Response.json({ data: [] })
      if (url.pathname === "/api/experimental/session/ses_input/wait") return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_input/message")
        return Response.json({
          data: prompts.map((prompt) => ({ id: prompt.id, type: "user", text: prompt.text, time: { created: 1 } })),
          cursor: {},
        })
      return new Response(null, { status: 404 })
    },
  })
  const child = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "run", "--server", server.url.toString(), ...args],
    {
      cwd: path.join(import.meta.dir, "../.."),
      env: isolatedEnv(directory.path),
      signal: AbortSignal.timeout(15_000),
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.text).toBe(expected)
  } finally {
    child.kill()
    await child.exited
    await server.stop(true)
  }
})
