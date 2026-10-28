import { audit } from "./audit";
import { build } from "./build";
import { deploy } from "./deploy";
import { deployPlan } from "./deploy-plan";
import { getConfig } from "./get-config";
import { uploadArtifacts } from "./upload-artifacts";

/** The hooks invoked by Jive's reusable CI/CD pipeline, by the names `CICD_API.md` gives them. */
export const cicd = {
  "get-config": getConfig,
  build,
  audit,
  "deploy-plan": deployPlan,
  "upload-artifacts": uploadArtifacts,
  deploy,
};
