import { Effect, Layer, Logger, Result, Schema, pipe } from "effect";
import { Command } from "commander";
import { effunct, type EffectGen } from "effective-modules";
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

/**
 * Wires the `cicd` subcommands of one abstract's CLI. Every abstract's hooks read the same pipeline inputs
 * and must map a typed failure onto a nonzero exit the same way, so that wiring is shared and only the
 * module graph a hook runs against differs.
 */
export interface CicdCommandFactory<R> {
  /** A `cicd` subcommand that takes no input from the pipeline (`get-config`, `build`, `audit`). */
  readonly makeCicdCommand: (name: string, description: string, action: CicdAction<R>) => Command;
  /** A `cicd` subcommand given the run's pipeline context but no deploy target (`upload-artifacts`). */
  readonly makePipelineCommand: (name: string, description: string, action: PipelineAction<R>) => Command;
  /** A deploy hook, which additionally receives the environment it is acting on (`deploy`). */
  readonly makeDeployCommand: (name: string, description: string, action: DeployAction<R>) => Command;
  /**
   * The `deploy-plan` hook: given the same input as `deploy`, its action decides whether there is anything to
   * deploy to that environment, and the command prints that decision as the JSON the pipeline validates.
   */
  readonly makeDeployPlanCommand: (name: string, description: string, action: DeployPlanAction<R>) => Command;
}

/**
 * Builds an abstract's hook commands against its own module graph. Each command runs its action with
 * `layer` provided, logs to stderr (two hooks' stdout is parsed by the pipeline), prints a failure as
 * `✗ <message>` and exits nonzero, so a failing hook fails its pipeline step.
 */
export function makeCicdCommandFactory<R, E>(layer: Layer.Layer<R, E, never>): CicdCommandFactory<R> {
  async function runCommand(program: () => EffectGen<void, string, R>): Promise<never> {
    const result = await Effect.runPromise(pipe(
      effunct(program)(),
      Effect.provide(layer),
      Effect.provide(Logger.layer([stderrLogger])),
      Effect.result,
    ));

    if (Result.isFailure(result)) {
      process.stderr.write(`✗ ${String(result.failure)}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  return {
    makeCicdCommand: (name, description, action) =>
      new Command(name).description(description).action(() => runCommand(action)),
    makePipelineCommand: (name, description, action) => {
      function* program(): EffectGen<void, string, R> {
        yield* action(yield* readPipelineContext(name));
      }
      return new Command(name).description(description).action(() => runCommand(program));
    },
    makeDeployCommand: (name, description, action) => {
      function* program(): EffectGen<void, string, R> {
        yield* action({
          environment: yield* readDeployEnvironment(name),
          context: yield* readPipelineContext(name),
        });
      }
      return new Command(name).description(description).action(() => runCommand(program));
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
      return new Command(name).description(description).action(() => runCommand(program));
    },
  };
}

export const { makeCicdCommand, makePipelineCommand, makeDeployCommand, makeDeployPlanCommand }: CicdCommandFactory<LibraryModules> =
  makeCicdCommandFactory(layerLive);
