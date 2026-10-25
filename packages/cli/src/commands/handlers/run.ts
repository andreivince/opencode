import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const separator = process.argv.indexOf("--", 2)
    const server = yield* ServerConnection.resolve().pipe(
      Effect.tapError((error) => Effect.logError("run could not resolve its server", { cause: error })),
      Effect.catch((error) => Effect.sync(() => reportRunError(input, failureMessage(error)))),
    )
    if (!server) return
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format: input.format,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  }),
)

// Connection errors carry a summary as their message and the actual reason (refused connection, TLS failure,
// invalid URL) as their innermost cause.
function failureMessage(error: unknown) {
  const message = errorMessage(error)
  const reason = innermostCause(error)?.message
  return reason && !message.includes(reason) ? `${message}: ${reason}` : message
}

function innermostCause(error: unknown): Error | undefined {
  if (!(error instanceof Error) || !(error.cause instanceof Error)) return
  return innermostCause(error.cause) ?? error.cause
}
