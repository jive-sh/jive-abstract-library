import { libraryModules } from "../../modules";
import { makeDeployCommand } from "../../common/command";

/** GitHub Actions renders the markdown appended to this file as the job's summary. */
const GITHUB_JOB_SUMMARY_ENV_VAR_NAME = "GITHUB_STEP_SUMMARY";

export const deploy = makeDeployCommand(
  "deploy",
  "stamp the built packages for this environment and publish them to npm",
  function* ({ environment, context }) {
    yield* (yield* libraryModules.Deployer).deploy({
      environment,
      sourceCommitSha: context.sourceCommitSha,
      maybeJobSummaryPath: yield* (yield* libraryModules.OSPlatform).readEnv(GITHUB_JOB_SUMMARY_ENV_VAR_NAME),
    });
  },
);
