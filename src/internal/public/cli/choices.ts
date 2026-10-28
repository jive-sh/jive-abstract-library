import { Cause, Effect, Exit, References, Result, pipe } from "effect";
import type { ListChoices } from "./tree";

/**
 * Runs an author's `choices` for help or Tab, where a failure must not fail the CLI: help still has the rest
 * to show, and a failing Tab must leave the line as it was. Logging is off while it runs, because help and
 * Tab write to stdout, which a logger could be writing to as well.
 *
 * @returns the values listed, or what went wrong in one line.
 */
export function listChoices(choices: ListChoices): Effect.Effect<Result.Result<ReadonlyArray<string>, string>, never, any> {
  return pipe(
    Effect.gen(choices),
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.exit,
    Effect.map((exit) => Exit.isSuccess(exit)
      ? Result.succeed(exit.value)
      : Result.fail(describeFailure(exit.cause))),
  );
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const failure = Cause.squash(cause);
  if (failure instanceof Error && failure.message !== "") return failure.message;
  if (typeof failure === "string") return failure;
  if (typeof failure === "object" && failure !== null && "_tag" in failure) return String(failure._tag);
  return String(failure);
}
