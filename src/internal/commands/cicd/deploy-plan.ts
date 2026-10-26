import { libraryModules } from "../../modules";
import { makeDeployPlanCommand } from "../../common/command";

export const deployPlan = makeDeployPlanCommand(
  "deploy-plan",
  "print whether this environment has a version to publish and, if so, its npm page",
  function* ({ environment, context }) {
    return yield* (yield* libraryModules.Deployer).plan({ environment, sourceCommitSha: context.sourceCommitSha });
  },
);
