import type { EffectGen } from "effective-modules";

/** A registry Jive provisions packages on. npm is the only one so far. */
export type PackageRegistry = "npm";

export interface ProvisionPackageInput {
  /** The Jive server deployment's URL, from the package's `provisionWithJive` setting. */
  readonly serverUrl: string;
  readonly registry: PackageRegistry;
  readonly packageName: string;
}

/** Jive's server, called as the pipeline job this process runs in. */
export interface IJiveServer {
  /**
   * Asks Jive to make the package ready for this job to publish (create it, and let this job's workflow
   * publish it by trusted publishing), succeeding once Jive answers that it is ready. While another deploy
   * job is provisioning the same package it asks again every 10 seconds, for up to 10 minutes. A refusal,
   * or a failure of the call itself, fails with Jive's reason: the caller must not publish.
   */
  provisionPackage(input: ProvisionPackageInput): EffectGen<void, string>;
}
