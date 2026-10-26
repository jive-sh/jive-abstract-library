import type { Option } from "effect";
import type { EffectGen } from "effective-modules";
import type { DeployPlan } from "../../public/deploy-plan";
import type { ProvisionWithJive } from "../../public/manifest";

export interface DeployInput {
  /** Target the build is being released to, e.g. "latest", "preview", or "local". */
  readonly environment: string;
  /** Commit the build came from; only the preview environment puts it in the version. */
  readonly sourceCommitSha: string;
  /**
   * The file the CI provider renders as this job's summary (GitHub Actions' `GITHUB_STEP_SUMMARY`). A
   * release appends its platform packages' download times to it; outside CI there is none.
   */
  readonly maybeJobSummaryPath: Option.Option<string>;
  /**
   * The package's `jive.library.provisionWithJive`: when set, a release asks that Jive server to provision
   * the package before publishing anything. The local environment never asks.
   */
  readonly provisionWithJive: Option.Option<ProvisionWithJive>;
}

export interface PlanInput {
  /** Target the plan is for, as `DeployInput.environment`. */
  readonly environment: string;
  /** Commit the build came from, as `DeployInput.sourceCommitSha`. */
  readonly sourceCommitSha: string;
}

export interface IDeployer {
  /**
   * Whether `deploy` would publish anything to this environment: nothing when the registry the package
   * publishes to already lists the base package at the version this environment stamps, since npm refuses
   * to publish over it. Otherwise the plan names that version's npm page. Only the base package is checked:
   * it is published last, so a release that failed after some platform packages went up is retried.
   */
  plan(input: PlanInput): EffectGen<DeployPlan, string>;
  /**
   * Stamps the built package folders with versions computed for this environment, then distributes
   * them: the local environment installs into the current workspace, every other environment packs,
   * asks Jive to provision the package when `provisionWithJive` is set, and publishes to npm.
   */
  deploy(input: DeployInput): EffectGen<void, string>;
}
