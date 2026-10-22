import { Effect, Result, Schema, SchemaIssue } from "effect";
import type { EffectGen } from "effective-modules";
import { CLI_CMD_NAME } from "./constants";

/**
 * JIVE_DEPLOY_ENVIRONMENT is a string passed to jive:cicd:deploy and jive:cicd:deploy:url
 * JIVE_PIPELINE_CONTEXT is a JSON passed to jive:cicd:deploy and jive:cicd:deploy:url and jive:cicd:upload-artifacts
 */

export const DEPLOY_ENVIRONMENT_ENV_VAR_NAME = "JIVE_DEPLOY_ENVIRONMENT";
export const PIPELINE_CONTEXT_ENV_VAR_NAME = "JIVE_PIPELINE_CONTEXT";

const CicdProvider = Schema.Literals(["Github", "Gitlab"]);
export type CicdProvider = typeof CicdProvider.Type;

const Repository = Schema.Struct({
  owner: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
});
export type Repository = typeof Repository.Type;

const CicdEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("PULL_REQUEST"),
    id: Schema.NonEmptyString,
    destinationBranch: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("COMMIT"),
  }),
  Schema.Struct({
    type: Schema.Literal("DIRECT_WORKFLOW_RUN"),
  }),
]);
export type CicdEvent = typeof CicdEvent.Type;

export const PipelineContextSchema = Schema.Struct({
  provider: CicdProvider,
  repository: Repository,
  sourceBranch: Schema.NonEmptyString,
  sourceCommitSha: Schema.NonEmptyString,
  event: CicdEvent,
});
export type PipelineContext = typeof PipelineContextSchema.Type;

/** Example shown on failure; pipeline-context.test.ts decodes it so the docs cannot drift. */
export const PIPELINE_CONTEXT_EXAMPLE: PipelineContext = {
  provider: "Github",
  repository: { owner: "jive-sh", name: "jive-abstract-library" },
  sourceBranch: "main",
  sourceCommitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  event: { type: "COMMIT" },
};

function usage(command: string): string {
  return [
    ``,
    `${PIPELINE_CONTEXT_ENV_VAR_NAME} must be a JSON object of this shape:`,
    ``,
    `  {`,
    `    "provider": "Github" | "Gitlab",`,
    `    "repository": { "owner": string, "name": string },`,
    `    "sourceBranch": string,        // the branch the commit is on, or a PR's source branch`,
    `    "sourceCommitSha": string,     // the commit being built, never a synthesized merge commit`,
    `    "event":`,
    `        { "type": "PULL_REQUEST", "id": string, "destinationBranch": string }`,
    `      | { "type": "COMMIT" }`,
    `      | { "type": "DIRECT_WORKFLOW_RUN" }`,
    `  }`,
    ``,
    `Jive's reusable pipeline sets this for you. To run this hook by hand:`,
    ``,
    `  ${PIPELINE_CONTEXT_ENV_VAR_NAME}='${JSON.stringify(PIPELINE_CONTEXT_EXAMPLE)}' \\`,
    `    ${CLI_CMD_NAME} cicd ${command}`,
    ``,
    `See @jive-sh/jive's CICD_API.md for the full contract.`,
  ].join("\n");
}

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export function* readPipelineContext(command: string): EffectGen<PipelineContext, string> {
  const raw = process.env[PIPELINE_CONTEXT_ENV_VAR_NAME];
  if (!raw) {
    return yield* Effect.fail(
      `${PIPELINE_CONTEXT_ENV_VAR_NAME} is not set — this command is invoked by Jive's pipeline.\n${usage(command)}`,
    );
  }

  const parsed = yield* Effect.result(Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (e) => `${PIPELINE_CONTEXT_ENV_VAR_NAME} is not valid JSON: ${(e as Error).message}`,
  }));
  if (Result.isFailure(parsed)) {
    return yield* Effect.fail(`${parsed.failure}\n${usage(command)}`);
  }

  const decoded = yield* Effect.result(
    Schema.decodeUnknownEffect(PipelineContextSchema, { onExcessProperty: "ignore" })(parsed.success),
  );
  if (Result.isFailure(decoded)) {
    return yield* Effect.fail(
      `${PIPELINE_CONTEXT_ENV_VAR_NAME} is malformed:\n${formatSchemaError(decoded.failure.issue)}\n${usage(command)}`,
    );
  }
  return decoded.success;
}

export function* readDeployEnvironment(command: string): EffectGen<string, string> {
  const environment = process.env[DEPLOY_ENVIRONMENT_ENV_VAR_NAME];
  if (!environment) {
    return yield* Effect.fail(
      `${DEPLOY_ENVIRONMENT_ENV_VAR_NAME} is not set — it names the deploy target, e.g. "latest".\n`
      + `Jive's reusable pipeline sets it for deploy hooks. To run this one by hand:\n\n`
      + `  ${DEPLOY_ENVIRONMENT_ENV_VAR_NAME}=latest ${CLI_CMD_NAME} cicd ${command}`,
    );
  }
  return environment;
}
