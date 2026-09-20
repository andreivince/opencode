import { describe, expect } from "bun:test"
import { Message, ToolCallPart, ToolResultPart } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { compileRequest } from "@opencode/ai/route/client"
import { Agent } from "@opencode/schema/agent"
import { Document, Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionRequestKind } from "@opencode/plugin/effect/session"
import { Config } from "@opencode/core/config"
import { ConfigProviderPlugin } from "@opencode/core/config/plugin/provider"
import { Location } from "@opencode/core/location"
import { ModelResolver } from "@opencode/core/model-resolver"
import { Plugin } from "@opencode/core/plugin"
import { PluginHost } from "@opencode/core/plugin/host"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { DateTime, Effect, Schema, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const KINDS: ReadonlyArray<SessionRequestKind> = ["primary", "compaction", "title", "generate"]

const session = Session.Info.make({
  id: Session.ID.make("ses_hook_kind"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})
const model = SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})
const transport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest tool capabilities", () => {
  it.effect("omits tools and tool choice when the configured model cannot call tools", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const host = yield* PluginHost.make(plugins)
      yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
        Effect.provide(
          Config.testLayer([
            new Document({
              type: "document",
              info: Schema.decodeUnknownSync(Info)({
                providers: {
                  custom: {
                    package: "@opencode/ai/providers/openai/chat",
                    models: { chat: { capabilities: { tools: false, input: ["text"], output: ["text"] } } },
                  },
                },
              }),
            }),
          ]),
        ),
      )
      const resolver = yield* ModelResolver.Service.pipe(Effect.provide(ModelResolver.layer))
      const selected = yield* resolver.resolve({ providerID: Provider.ID.make("custom"), id: Model.ID.make("chat") })
      if (!selected) throw new Error("Expected the configured model")
      const registry = yield* Tool.Service
      const tools = yield* registry.snapshot()
      expect(tools.definitions.length).toBeGreaterThan(0)
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model: selected,
          tools,
          toolChoice: "auto",
          system: [],
          messages: [Message.user("Reply with OK")],
        })
        const compiled = yield* compileRequest(prepared.request)

        expect(prepared.request.tools).toEqual([])
        expect(prepared.request.toolChoice).toBeUndefined()
        expect(compiled.body.tools).toBeUndefined()
        expect(compiled.body.tool_choice).toBeUndefined()
      }
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("restores tools when switching to a capable model without changing the snapshot", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* registry.transform((draft) =>
        draft.add({
          name: "lookup",
          description: "Look up a value",
          options: { codemode: false },
          input: Schema.Struct({}),
          execute: () => Effect.succeed({ content: "found" }),
        }),
      )
      const tools = yield* registry.snapshot()
      const hooks = yield* PluginHooks.Service
      const seen: string[][] = []
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          seen.push(Object.keys(event.tools))
          event.tools.search = event.tools.lookup ?? { description: "Look up a value", input: { type: "object" } }
          delete event.tools.lookup
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const input = {
        session,
        agent: Agent.ID.make("build"),
        tools,
        system: [],
        messages: [Message.user("Reply with OK")],
        toolChoice: "auto" as const,
      }
      const disabled = yield* requests.primary({
        ...input,
        model: { ...model, capabilities: { ...model.capabilities, tools: false } },
      })
      const enabled = yield* requests.primary({ ...input, model })
      const compiled = yield* compileRequest(enabled.request)

      expect(disabled.request.tools).toEqual([])
      expect(seen).toEqual([[], ["lookup", "execute"]])
      expect(enabled.request.tools.map((tool) => tool.name)).toEqual(["execute", "search"])
      expect(compiled.body.tools).toEqual([
        expect.objectContaining({ function: expect.objectContaining({ name: "execute" }) }),
        expect.objectContaining({ function: expect.objectContaining({ name: "search" }) }),
      ])
      expect(compiled.body.tool_choice).toBe("auto")
      expect(tools.definitions.map((tool) => tool.name)).toEqual(["lookup", "execute"])

      const call = {
        sessionID: session.id,
        agent: input.agent,
        messageID: SessionMessage.ID.make("msg_tools"),
        call: ToolCallPart.make({ id: "call_lookup", name: "search", input: {} }),
      }
      expect(yield* disabled.executeTool(call).pipe(Effect.flip)).toBeInstanceOf(Tool.Error)
      expect((yield* enabled.executeTool(call)).content).toEqual([{ type: "text", text: "found" }])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("preserves tool history when the next model cannot call tools", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      const tools = yield* registry.snapshot()
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const messages = [
        Message.user("Read the file"),
        Message.assistant(ToolCallPart.make({ id: "call_read", name: "read", input: { path: "file.txt" } })),
        Message.tool(
          ToolResultPart.make({ id: "call_read", name: "read", result: { type: "text", value: "contents" } }),
        ),
        Message.user("Summarize the result"),
      ]
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: { ...model, capabilities: { ...model.capabilities, tools: false } },
        tools,
        system: [],
        messages,
      })

      expect(prepared.request.tools).toEqual([])
      expect(prepared.request.messages).toEqual(messages)
      const compiled = yield* compileRequest(prepared.request)
      expect(compiled.body.tools).toEqual([])
      expect(compiled.body.tool_choice).toBeUndefined()
      expect(compiled.body.messages).toMatchObject([
        { role: "user", content: "Read the file" },
        {
          role: "assistant",
          tool_calls: [
            { id: "call_read", type: "function", function: { name: "read", arguments: '{"path":"file.txt"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_read", content: "contents" },
        { role: "user", content: "Summarize the result" },
      ])
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )
})

describe("SessionModelRequest HTTP hooks", () => {
  it.effect("tags every Session request kind on http.request and http.response", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: Array<{ hook: string; kind: SessionRequestKind; agent: Agent.ID }> = []
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "request", kind: event.kind, agent: event.agent })
        }),
      )
      yield* hooks.register("session", "http.response", (event) =>
        Effect.sync(() => {
          seen.push({ hook: "response", kind: event.kind, agent: event.agent })
        }),
      )
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))

      for (const kind of KINDS) {
        const prepared = yield* requests[kind]({
          session,
          agent: Agent.ID.make("build"),
          model,
          system: [],
          messages: [],
        })
        const http = prepared.options.http
        if (!http) throw new Error(`Expected HTTP middleware for ${kind}`)
        yield* http(HttpClientRequest.post("https://example.test/v1/chat/completions"), (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
        )
      }

      expect(seen).toEqual(
        KINDS.flatMap((kind) => [
          { hook: "request", kind, agent: Agent.ID.make("build") },
          { hook: "response", kind, agent: Agent.ID.make("build") },
        ]),
      )
    }).pipe(Effect.provideService(SessionModelTransport.Service, transport)),
  )

  it.effect("offers the WebSocket executor alongside HTTP hooks and routes the WebSocket hooks", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const seen: string[] = []
      yield* hooks.register("session", "http.request", () => Effect.sync(() => void seen.push("http.request")))
      yield* hooks.register("session", "experimental.ws.handshake", (event) =>
        Effect.sync(() => {
          seen.push(`handshake:${event.kind}:${event.url}`)
          event.headers.authorization = "Bearer minted"
          delete event.headers["api-key"]
        }),
      )
      yield* hooks.register("session", "experimental.ws.send", (event) =>
        Effect.sync(() => {
          seen.push(`send:${event.kind}:${event.frame}`)
          event.frame = `${event.frame}+plugin`
        }),
      )
      yield* hooks.register("session", "experimental.ws.receive", (event) =>
        Effect.sync(() => {
          seen.push(`receive:${event.kind}:${event.frame}`)
          event.frame = event.frame.toUpperCase()
        }),
      )
      const bound: Array<{ url: string; headers: Record<string, string> }> = []
      const frames: string[] = []
      const websocketTransport = SessionModelTransport.Service.of({
        bind: (_sessionID, interceptor) => ({
          execute: () =>
            Effect.gen(function* () {
              if (!interceptor?.handshake || !interceptor.send || !interceptor.receive)
                throw new Error("Expected a full WebSocket interceptor")
              bound.push(
                yield* interceptor.handshake({ url: "wss://example.test/v1/responses", headers: { "api-key": "k" } }),
              )
              frames.push(yield* interceptor.send("create"))
              frames.push(yield* interceptor.receive("created"))
              return { frames: Stream.empty, complete: Effect.void }
            }),
        }),
        close: () => Effect.void,
        closeAll: Effect.void,
      })
      const requests = yield* SessionModelRequest.Service.pipe(
        Effect.provide(SessionModelRequest.layer),
        Effect.provideService(SessionModelTransport.Service, websocketTransport),
      )
      const prepared = yield* requests.primary({
        session,
        agent: Agent.ID.make("build"),
        model: SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          cost: [],
          limit: { context: 200_000, output: 32_000 },
          transport: "websocket",
        }),
        system: [],
        messages: [],
        webSocket: "session",
      })

      expect(prepared.options.http).toBeDefined()
      expect(prepared.options.webSocket).toBeDefined()
      yield* prepared.options.webSocket!.execute({} as never)
      expect(bound).toEqual([{ url: "wss://example.test/v1/responses", headers: { authorization: "Bearer minted" } }])
      expect(frames).toEqual(["create+plugin", "CREATED"])
      expect(seen).toEqual([
        "handshake:primary:wss://example.test/v1/responses",
        "send:primary:create",
        "receive:primary:created",
      ])
    }),
  )
})
