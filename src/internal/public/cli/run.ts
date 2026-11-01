import { Data, Effect, Layer, Match, Option, Runtime, Sink, Stdio, Stream, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct, type EffectGen } from "effective-modules";
import { libraryModules, type LibraryModules } from "../../modules";
import { OSPlatformImpl } from "../../modules/os-platform/impl";
import { ShellCompletionImpl } from "../../modules/shell-completion/impl";
import type { CompletionSetup, IShellCompletion } from "../../modules/shell-completion/interface";
import { completionScript } from "../../modules/shell-completion/scripts";
import { complete, formatCompletion } from "./completion";
import { renderHelp } from "./help";
import { COMPLETION_PROTOCOL, REMOVE_COMPLETION_FLAG, parseInvocation } from "./parse";
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
          const setup = yield* completionChange((shellCompletion) => shellCompletion.setUp(cli.name));
          yield* stdout(`Tab completion for ${cli.name} is set up for ${setup.shell} in ${setup.files.join(" and ")}; it starts in new shells.\n${warningLines(setup)}`);
        }),
        RemoveCompletion: () => Effect.gen(function* () {
          const setup = yield* completionChange((shellCompletion) => shellCompletion.remove(cli.name));
          yield* stdout(`Tab completion for ${cli.name} is removed for ${setup.shell} from ${setup.files.join(" and ")}; it stops in new shells.\n`);
        }),
        // On stderr: the launcher runs this before the command the user typed, whose stdout may be read by a program.
        SetUpMissingCompletion: () => Effect.gen(function* () {
          const outcome = yield* completionChange((shellCompletion) => shellCompletion.setUpMissing(cli.name));
          if (outcome._tag !== "SetUp") return;
          const { setup } = outcome;
          yield* stderr(`Set up Tab completion for ${cli.name} in ${setup.files.join(" and ")}; it starts in new shells (turn it off with: ${cli.name} ${REMOVE_COMPLETION_FLAG}).\n${warningLines(setup)}`);
        }),
        CompletionScript: ({ shell }) => stdout(completionScript(shell, cli.name)),
        CompletionProtocol: () => stdout(`${COMPLETION_PROTOCOL}\n`),
        UsageError: ({ message, node, path }) => Effect.gen(function* () {
          yield* stderr(`${message}\n\n${yield* renderHelp(cli, node, path)}`);
          return yield* new CliError({ message, exitCode: USAGE_EXIT_CODE });
        }),
        InvalidDefinition: ({ message }) => Effect.die(new Error(`${cli.name} is defined wrongly: ${message}`)),
      }),
    );

    function completionChange<A>(change: (shellCompletion: IShellCompletion) => EffectGen<A, string>) {
      return pipe(
        effunct(function* (): EffectGen<A, string, LibraryModules.ShellCompletion> {
          return yield* change(yield* libraryModules.ShellCompletion);
        })(),
        Effect.provide(completionLayer),
        Effect.catch((message: string) => failWith(`Tab completion for ${cli.name}: ${message}`, 1)),
      );
    }
  });
}

function warningLines(setup: CompletionSetup): string {
  return setup.warnings.map((warning) => `${warning}\n`).join("");
}
