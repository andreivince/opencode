import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Integration, OpenCode } from "../src/effect/index"

for (const credentialType of ["key", "oauth", undefined]) {
  test(`integration responses preserve ${credentialType ?? "older"} credential metadata`, async () => {
    const connection = {
      type: "credential",
      id: "cred_test",
      label: "Account",
      ...(credentialType ? { credentialType } : {}),
    }
    const httpClient = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            location: { directory: "/repo" },
            data: { id: "openai", name: "OpenAI", methods: [], connections: [connection] },
          }),
        ),
      ),
    )
    const result = await Effect.gen(function* () {
      const client = yield* OpenCode.make({ baseUrl: "http://localhost:3000" })
      return yield* client.integration.get({ integrationID: Integration.ID.make("openai") })
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient), Effect.runPromise)

    expect(result.data.connections).toEqual([connection])
  })
}
