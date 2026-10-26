import type { Option } from "effect";
import type { EffectGen } from "effective-modules";

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
}

export interface IDeployer {
  /**
   * Stamps the built package folders with versions computed for this environment, then distributes
   * them: the local environment installs into the current workspace, every other environment packs
   * and publishes to npm.
   */
  deploy(input: DeployInput): EffectGen<void, string>;
}
