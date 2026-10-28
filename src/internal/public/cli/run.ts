import { Data, Effect, Layer, Match, Option, Runtime, Sink, Stdio, Stream, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct } from "effective-modules";
import { libraryModules } from "../../modules";
import { OSPlatformImpl } from "../../modules/os-platform/impl";
import { ShellCompletionImpl } from "../../modules/shell-completion/impl";
import { complete, formatCompletion } from "./completion";
import { renderHelp } from "./help";
import { parseInvocation } from "./parse";
import type { Cli } from "./tree";

/**
 * Why a CLI stopped without running a command: the words could not be run, or Tab completion could not be
 * turned on or off. `run` has already printed the message, so the runtime does not print it again, and exits
 * with `exitCode`.
 */
export class CliError extends Data.TaggedError("CliError")<{ readonly message: string; readonly exitCode: number }> {
  override get [Runtime.errorExitCode]() {
    return this.exitCode;
  }
  override readonly [Runtime.errorReported] = false;
}

/** The conventional exit code for a command used wrongly. */
const USAGE_EXIT_CODE = 2;

/** Only what turning completion on and off needs; it is bundled into every CLI built on this. */
const completionLayer = pipe(
  ShellCompletionImpl.Layer,
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
) satisfies Layer.Layer<any, any, never>;

/**
 * Runs a CLI on the arguments `Stdio` holds (`BunServices.layer` gives the process's own). Prints help or the
 * version, answers a shell's Tab, turns Tab completion on or off, or runs the command the words lead to.
 *
 * Fails with what the command's `run` failed with, or with `CliError` once the problem has been printed.
 */
export function run<E, R>(
  cli: Cli<E, R>,
  options: { readonly version: string },
): Effect.Effect<void, E | CliError, R | Stdio.Stdio> {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const write = (sink: Sink.Sink<void, string | Uint8Array, never, unknown>, text: string) =>
      Effect.orDie(Stream.run(Stream.make(text), sink));
    const stdout = (text: string) => write(stdio.stdout(), text);
    const stderr = (text: string) => write(stdio.stderr(), text);
    const failWith = (message: string, exitCode: number) =>
      Effect.andThen(stderr(`${message}\n`), Effect.fail(new CliError({ message, exitCode })));

    const invocation = parseInvocation(cli, yield* stdio.args);
    return yield* pipe(
      invocation,
      Match.valueTags({
        Execute: ({ command, flags, args }) => Effect.gen(() => command.run({ flags, args })),
        Help: ({ node, path }) => Effect.flatMap(renderHelp(cli, node, path), stdout),
        Version: () => stdout(`${options.version}\n`),
        Complete: ({ words }) => Effect.gen(function* () {
          const { candidates, failure } = yield* complete(cli, words);
          yield* stdout(formatCompletion(candidates));
          // On its own line, so it is not mistaken for part of what was typed.
          if (Option.isSome(failure)) yield* stderr(`\n${cli.name}: could not list choices: ${failure.value}\n`);
        }),
        SetUpCompletion: () => Effect.gen(function* () {
          const files = yield* completionChange(cli.name, "set up");
          const reload = Option.match(files.startupFile, {
            onNone: () => "Open a new shell to use it.",
            onSome: (startupFile) => `Open a new shell, or run: source ${startupFile}`,
          });
          yield* stdout(`Tab completion for ${cli.name} is set up for ${files.shell}. ${reload}\n`);
        }),
        RemoveCompletion: () => Effect.gen(function* () {
          const files = yield* completionChange(cli.name, "remove");
          yield* stdout(`Tab completion for ${cli.name} is removed for ${files.shell}; it stops in new shells.\n`);
        }),
        UsageError: ({ message, node, path }) => Effect.gen(function* () {
          yield* stderr(`${message}\n\n${yield* renderHelp(cli, node, path)}`);
          return yield* new CliError({ message, exitCode: USAGE_EXIT_CODE });
        }),
        InvalidDefinition: ({ message }) => Effect.die(new Error(`${cli.name} is defined wrongly: ${message}`)),
      }),
    );

    function completionChange(commandName: string, change: "set up" | "remove") {
      return pipe(
        effunct(function* () {
          const shellCompletion = yield* libraryModules.ShellCompletion;
          return change === "set up" ? yield* shellCompletion.setUp(commandName) : yield* shellCompletion.remove(commandName);
        })(),
        Effect.provide(completionLayer),
        Effect.catch((message: string) => failWith(message, 1)),
      );
    }
  });
}
