import { Effect, Layer, Logger, Schema, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { CliError } from "../public/cli/run";
import { command, type Command } from "../public/cli/tree";
import { layerLive } from "./layer";
import { stderrLogger } from "./logger";
import { readDeployEnvironment, readPipelineContext, type PipelineContext } from "./pipeline-context";
import { DeployPlan } from "../public/deploy-plan";
import type { LibraryModules } from "../modules";

type CicdAction<R> = () => EffectGen<void, string, R>;
type PipelineAction<R> = (context: PipelineContext) => EffectGen<void, string, R>;
type DeployInput = { environment: string; context: PipelineContext };
type DeployAction<R> = (input: DeployInput) => EffectGen<void, string, R>;
type DeployPlanAction<R> = (input: DeployInput) => EffectGen<DeployPlan, string, R>;

/** A hook as a `Cli` command: it takes no flags, and fails with `CliError` once it has printed why. */
export type CicdCommand = Command<{}, CliError, never>;

/**
 * Wires the `cicd` subcommands of one abstract's CLI. Every abstract's hooks read the same pipeline inputs
 * and must map a typed failure onto a nonzero exit the same way, so that wiring is shared and only the
 * module graph a hook runs against differs.
 */
export interface CicdCommandFactory<R> {
  /** A `cicd` subcommand that takes no input from the pipeline (`get-config`, `build`, `audit`). */
  readonly makeCicdCommand: (name: string, description: string, action: CicdAction<R>) => CicdCommand;
  /** A `cicd` subcommand given the run's pipeline context but no deploy target (`upload-artifacts`). */
  readonly makePipelineCommand: (name: string, description: string, action: PipelineAction<R>) => CicdCommand;
  /** A deploy hook, which additionally receives the environment it is acting on (`deploy`). */
  readonly makeDeployCommand: (name: string, description: string, action: DeployAction<R>) => CicdCommand;
  /**
   * The `deploy-plan` hook: given the same input as `deploy`, its action decides whether there is anything to
   * deploy to that environment, and the command prints that decision as the JSON the pipeline validates.
   */
  readonly makeDeployPlanCommand: (name: string, description: string, action: DeployPlanAction<R>) => CicdCommand;
}

/**
 * Builds an abstract's hook commands against its own module graph. Each command runs its action with
 * `layer` provided, logs to stderr (two hooks' stdout is parsed by the pipeline), and on failure prints
 * `✗ <message>` and fails with `CliError` (exit code 1), so a failing hook fails its pipeline step.
 */
export function makeCicdCommandFactory<R, E>(layer: Layer.Layer<R, E, never>): CicdCommandFactory<R> {
  function hookCommand(description: string, program: () => EffectGen<void, string, R>): CicdCommand {
    const hook: Effect.Effect<void, CliError> = pipe(
      effunct(program)(),
      Effect.provide(layer),
      Effect.provide(Logger.layer([stderrLogger])),
      // The action's own message, or the layer failing to build.
      Effect.catch((failure: unknown) => Effect.andThen(
        Effect.sync(() => process.stderr.write(`✗ ${String(failure)}\n`)),
        Effect.fail(new CliError({ message: String(failure), exitCode: 1 })),
      )),
    );
    return command({
      description,
      *run(): Effect.fn.Return<void, CliError> {
        yield* hook;
      },
    });
  }

  return {
    makeCicdCommand: (_name, description, action) => hookCommand(description, action),
    makePipelineCommand: (name, description, action) => {
      function* program(): EffectGen<void, string, R> {
        yield* action(yield* readPipelineContext(name));
      }
      return hookCommand(description, program);
    },
    makeDeployCommand: (name, description, action) => {
      function* program(): EffectGen<void, string, R> {
        yield* action({
          environment: yield* readDeployEnvironment(name),
          context: yield* readPipelineContext(name),
        });
      }
      return hookCommand(description, program);
    },
    makeDeployPlanCommand: (name, description, action) => {
      function* program(): EffectGen<void, string, R> {
        const plan = yield* action({
          environment: yield* readDeployEnvironment(name),
          context: yield* readPipelineContext(name),
        });
        const encoded = yield* pipe(
          Schema.encodeUnknownEffect(DeployPlan)(plan),
          Effect.mapError((e) => `${name} produced an invalid plan: ${e.message}`),
        );
        process.stdout.write(`${JSON.stringify(encoded)}\n`);
      }
      return hookCommand(description, program);
    },
  };
}

export const { makeCicdCommand, makePipelineCommand, makeDeployCommand, makeDeployPlanCommand }: CicdCommandFactory<LibraryModules> =
  makeCicdCommandFactory(layerLive);
