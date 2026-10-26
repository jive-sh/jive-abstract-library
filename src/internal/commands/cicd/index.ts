import { Command } from "commander";
import { audit } from "./audit";
import { build } from "./build";
import { deploy } from "./deploy";
import { deployPlan } from "./deploy-plan";
import { getConfig } from "./get-config";
import { uploadArtifacts } from "./upload-artifacts";

export const cicd = new Command("cicd")
  .summary("hooks invoked by Jive's reusable CI/CD pipeline");

[getConfig, build, audit, deployPlan, uploadArtifacts, deploy]
  .forEach((command) => { cicd.addCommand(command); });
