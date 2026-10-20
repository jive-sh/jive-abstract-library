import { Effect, Logger, Result, pipe } from "effect";
import { Command } from "commander";
import { effunct, type EffectGen } from "effective-modules";
import { layerLive } from "./layer";
import { stderrLogger } from "./logger";
import { readDeployEnvironment, readPipelineContext, type PipelineContext } from "./pipeline-context";
import type { LibraryModules } from "../modules";

/**
 * Runs one command's action against the live module graph and maps a typed failure onto a
 * nonzero exit, so a failing hook fails its pipeline step.
 */
export async function runCommand(program: () => EffectGen<void, string, LibraryModules>): Promise<never> {
  const result = await Effect.runPromise(pipe(
    effunct(program)(),
    Effect.provide(layerLive),
    Effect.provide(Logger.layer([stderrLogger])),
    Effect.result,
  ));

  if (Result.isFailure(result)) {
    process.stderr.write(`✗ ${result.failure}\n`);
    process.exit(1);
  }
  process.exit(0);
}

type CicdAction = () => EffectGen<void, string, LibraryModules>;
type PipelineAction = (context: PipelineContext) => EffectGen<void, string, LibraryModules>;
type DeployAction = (input: { environment: string; context: PipelineContext }) => EffectGen<void, string, LibraryModules>;

/** Wires a `cicd` subcommand that takes no input from the pipeline. */
export function makeCicdCommand(name: string, description: string, action: CicdAction): Command {
  return new Command(name).description(description).action(() => runCommand(action));
}

/** Wires a `cicd` subcommand given the run's pipeline context but no deploy target. */
export function makePipelineCommand(name: string, description: string, action: PipelineAction): Command {
  function* program(): EffectGen<void, string, LibraryModules> {
    yield* action(yield* readPipelineContext(name));
  }
  return new Command(name).description(description).action(() => runCommand(program));
}

/** Wires a deploy hook, which additionally receives the environment it is acting on. */
export function makeDeployCommand(name: string, description: string, action: DeployAction): Command {
  function* program(): EffectGen<void, string, LibraryModules> {
    yield* action({
      environment: yield* readDeployEnvironment(name),
      context: yield* readPipelineContext(name),
    });
  }
  return new Command(name).description(description).action(() => runCommand(program));
}
