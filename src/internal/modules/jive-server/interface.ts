import type { EffectGen } from "effective-modules";

export interface ProvisionPackageInput {
  readonly packageName: string;
}

/** Jive, reached as the pipeline job this process runs in. */
export interface IJiveServer {
  /**
   * Signs this job in to Jive (`jive login --cicd`), then makes sure the package exists and this job's workflow may
   * publish it (`jive provision connector-package-registry <name>`). A refusal, an outside system needing a person,
   * or a failure of either command fails with jive's reason: the caller must not publish.
   */
  provisionPackage(input: ProvisionPackageInput): EffectGen<void, string>;
}
