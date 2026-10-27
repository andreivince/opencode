import { describe, expect, test } from "bun:test"
import { currentValue } from "./select-options"
import { durableEvent, rpcError, secondModel, startWire } from "./wire-fixture"

describe("acp catalog and config options over the wire", () => {
  test("switches model, effort, and mode against the warm catalog", async () => {
    await using acp = await startWire()
    acp.server.catalog.models.push({ ...secondModel, providerID: "test/sub" })
    await acp.initialize()
    const sessionId = (await acp.newSession()).sessionId
    const set = (configId: string, value: string) =>
      acp.request("session/set_config_option", { sessionId, configId, value })

    const selectedModel = await set("model", "test/second-model")
    const selectedEffort = await set("effort", "medium")
    const selectedMode = await set("mode", "plan")
    await acp.request("session/set_mode", { sessionId, modeId: "build" })

    expect(currentValue(selectedModel, "model")).toBe("test/second-model")
    expect(currentValue(selectedModel, "effort")).toBe("default")
    expect(currentValue(selectedEffort, "effort")).toBe("medium")
    expect(currentValue(selectedMode, "mode")).toBe("plan")
    expect(acp.server.selections).toEqual([
      { sessionID: sessionId, model: { providerID: "test", id: secondModel.id } },
      { sessionID: sessionId, model: { providerID: "test", id: secondModel.id, variant: "medium" } },
      { sessionID: sessionId, agent: "plan" },
      { sessionID: sessionId, agent: "build" },
    ])

    expect(await rpcError(set("effort", "maximum"))).toMatchObject({ code: -32602, data: { effort: "maximum" } })
    expect(await rpcError(set("mode", "missing"))).toMatchObject({ code: -32602, data: { mode: "missing" } })
    expect(await rpcError(set("missing", "value"))).toMatchObject({ code: -32602, data: { configId: "missing" } })
    expect(await rpcError(set("model", "test/missing-model"))).toMatchObject({
      code: -32602,
      data: { modelId: "test/missing-model" },
    })
    const overlap = "test/sub/second-model"
    expect(currentValue(await set("model", overlap), "model")).toBe(overlap)
    expect(currentValue(await set("model", `${overlap}/low`), "effort")).toBe("low")
  })

  test.each([
    ["model", "test/second-model", "model"],
    ["mode", "plan", "agent"],
  ])("keeps the current selection when a %s switch fails", async (configId, value, endpoint) => {
    let reject = true
    await using acp = await startWire({
      fetch: (request) => {
        if (!reject || !request.path.endsWith(`/${endpoint}`) || request.method !== "POST") return
        reject = false
        return new Response("temporarily unavailable", { status: 503 })
      },
    })
    await acp.initialize()
    const sessionId = (await acp.newSession()).sessionId
    const set = (configId: string, value: string) =>
      acp.request("session/set_config_option", { sessionId, configId, value })

    expect(await rpcError(set(configId, value))).toMatchObject({ code: -32603 })
    const selected = await set("effort", "high")

    expect([currentValue(selected, "model"), currentValue(selected, "effort"), currentValue(selected, "mode")]).toEqual(
      ["test/test-model", "high", "build"],
    )
    expect(acp.server.selections).toEqual([
      { sessionID: sessionId, model: { providerID: "test", id: "test-model", variant: "high" } },
    ])
  })

  test("keeps a newer server selection received before a switch responds", async () => {
    const response = Promise.withResolvers<Response>()
    await using acp = await startWire({
      fetch: (request) => {
        if (request.path.endsWith("/agent") && request.method === "POST") return response.promise
      },
    })
    await acp.initialize()
    const session = await acp.newSession()
    const setting = acp.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "mode",
      value: "plan",
    })
    try {
      await acp.until(() => acp.server.requests.some((request) => request.path.endsWith("/agent")))
      acp.server.send(
        durableEvent("session.agent.selected", { sessionID: session.sessionId, agent: "plan" }),
        durableEvent("session.agent.selected", { sessionID: session.sessionId, agent: "build" }),
      )
      await acp.until(() =>
        acp.updates.some(
          (item) =>
            item.update.sessionUpdate === "config_option_update" && currentValue(item.update, "mode") === "build",
        ),
      )
    } finally {
      response.resolve(new Response(null, { status: 204 }))
    }
    expect(currentValue(await setting, "mode")).toBe("build")
    expect(
      acp.updates.flatMap((item) =>
        item.update.sessionUpdate === "config_option_update" ? [currentValue(item.update, "mode")] : [],
      ),
    ).toEqual(["build"])
  })

  test("keeps an independent server selection when a switch fails", async () => {
    const response = Promise.withResolvers<Response>()
    let reject = true
    await using acp = await startWire({
      fetch: (request) => {
        if (!reject || !request.path.endsWith("/model") || request.method !== "POST") return
        reject = false
        return response.promise
      },
    })
    await acp.initialize()
    const sessionId = (await acp.newSession()).sessionId
    const setting = rpcError(
      acp.request("session/set_config_option", { sessionId, configId: "model", value: "test/second-model" }),
    )
    try {
      await acp.until(() => acp.server.requests.some((request) => request.path.endsWith("/model")))
      acp.server.send(durableEvent("session.agent.selected", { sessionID: sessionId, agent: "plan" }))
      await acp.until(() =>
        acp.updates.some(
          (item) =>
            item.update.sessionUpdate === "config_option_update" && currentValue(item.update, "mode") === "plan",
        ),
      )
    } finally {
      response.resolve(new Response("temporarily unavailable", { status: 503 }))
    }
    expect(await setting).toMatchObject({ code: -32603 })
    const selected = await acp.request("session/set_config_option", { sessionId, configId: "effort", value: "high" })
    expect([currentValue(selected, "model"), currentValue(selected, "effort"), currentValue(selected, "mode")]).toEqual(
      ["test/test-model", "high", "plan"],
    )
  })

  test.each([
    ["accepted", "high"],
    ["rejected", "default"],
  ])("keeps accepted state across overlapping switches when the newer request is %s", async (outcome, effort) => {
    const responses = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
    let requests = 0
    await using acp = await startWire({
      fetch: (request) => {
        if (!request.path.endsWith("/model") || request.method !== "POST") return
        const index = requests++
        if (index === 0 || (index === 1 && outcome === "rejected")) return responses[index]?.promise
      },
    })
    await acp.initialize()
    const sessionId = (await acp.newSession()).sessionId
    const first = rpcError(
      acp.request("session/set_config_option", { sessionId, configId: "model", value: "test/second-model" }),
    )
    try {
      await acp.until(() => acp.server.requests.filter((request) => request.path.endsWith("/model")).length === 1)
      const later = acp.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: "test/test-model/high",
      })
      const result = outcome === "rejected" ? rpcError(later) : later
      await acp.until(() => acp.server.requests.filter((request) => request.path.endsWith("/model")).length === 2)
      if (outcome === "accepted") await result
      responses[0]?.resolve(new Response("temporarily unavailable", { status: 503 }))
      expect(await first).toMatchObject({ code: -32603 })
      responses[1]?.resolve(new Response("temporarily unavailable", { status: 503 }))
      if (outcome === "rejected") expect(await result).toMatchObject({ code: -32603 })
    } finally {
      for (const response of responses) response.resolve(new Response("temporarily unavailable", { status: 503 }))
    }
    const selected = await acp.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" })
    expect([currentValue(selected, "model"), currentValue(selected, "effort")]).toEqual(["test/test-model", effort])
  })

  test("keeps the last accepted selection when overlapping switches both succeed", async () => {
    const responses = [Promise.withResolvers<Response | undefined>(), Promise.withResolvers<Response | undefined>()]
    let requests = 0
    await using acp = await startWire({
      fetch: (request) => {
        if (!request.path.endsWith("/model") || request.method !== "POST" || requests >= responses.length) return
        return responses[requests++]?.promise
      },
    })
    await acp.initialize()
    const sessionId = (await acp.newSession()).sessionId
    const older = acp.request("session/set_config_option", { sessionId, configId: "model", value: "test/second-model" })
    await acp.until(() => acp.server.requests.filter((request) => request.path.endsWith("/model")).length === 1)
    const newer = acp.request("session/set_config_option", {
      sessionId,
      configId: "model",
      value: "test/test-model/high",
    })
    try {
      await acp.until(() => acp.server.requests.filter((request) => request.path.endsWith("/model")).length === 2)
      responses[0]?.resolve(undefined)
      await older
      responses[1]?.resolve(undefined)
      const selected = await newer
      expect(acp.server.selections).toEqual([
        { sessionID: sessionId, model: { providerID: "test", id: "second-model" } },
        { sessionID: sessionId, model: { providerID: "test", id: "test-model", variant: "high" } },
      ])
      expect([currentValue(selected, "model"), currentValue(selected, "effort")]).toEqual(["test/test-model", "high"])
    } finally {
      for (const response of responses) response.resolve(undefined)
      await Promise.all([older, newer])
    }
  })

  test("answers the first session after a cold location activates its plugins (#52729, #52472)", async () => {
    await using acp = await startWire()
    const plugins = acp.server.catalog.plugins.splice(0)
    acp.server.catalog.models.splice(1)
    await acp.initialize()
    const activated = Bun.sleep(200).then(() => {
      acp.server.catalog.plugins.push(...plugins)
      acp.server.catalog.models.push(secondModel)
    })

    const session = await acp.newSession()
    const selected = await acp.request("session/set_config_option", {
      sessionId: session.sessionId,
      configId: "model",
      value: "test/second-model",
    })
    await activated

    expect(session.configOptions).toContainEqual(
      expect.objectContaining({
        id: "model",
        options: [
          { value: "test/second-model", name: "test/Second Model" },
          { value: "test/test-model", name: "test/Test Model" },
        ],
      }),
    )
    expect(currentValue(selected, "model")).toBe("test/second-model")
  })
})
