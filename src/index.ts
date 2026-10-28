/**
 * The public surface of this abstract.
 *
 * What lives here: the shape a package.json must have to be built by this abstract, the release helpers a
 * package's own deploy script may need, the dev server, daemon registration, upgrades, and the pieces every
 * other abstract builds its own CLI from: `makeCicdCommandFactory` (the six hooks' input reading, output printing
 * and exit handling), `makeJivePackageJsonSchema` (the fields every Jive package has, plus that abstract's own block)
 * and `loadPackageJson`. An abstract imports these rather than restating them.
 */

export {
  ensureNpm,
  planNpmRelease,
  publishPackage,
  releaseDistTag,
  releaseVersion,
  type ReleaseTarget,
} from "./internal/public/release";

export {
  CicdSchema,
  GENERATED_PACKAGE_JSON_FIELDS,
  JivePackageConfig,
  LATEST_ENVIRONMENT,
  LOCAL_ENVIRONMENT,
  LibrarySchema,
  PREVIEW_ENVIRONMENT,
  PackageJsonSchema,
  ProvisionWithJiveSchema,
  REQUIRED_SCRIPTS,
  RESERVED_ENVIRONMENTS,
  isEnvironment,
  makeJivePackageJsonSchema,
  makeLibrarySchema,
  makePackageJsonSchema,
  type CicdConfig,
  type LibraryConfig,
  type PackageJson,
  type ProvisionWithJive,
} from "./internal/public/manifest";

export { loadPackageJson } from "./internal/public/package-json";

export { DeployPlan } from "./internal/public/deploy-plan";

export { makeCicdCommandFactory, type CicdCommandFactory } from "./internal/common/command";
export type { PipelineContext } from "./internal/common/pipeline-context";

export { discoverDaemonNames, packageRootDir } from "./internal/public/daemons";

export {
  genPackageJsonSchema,
  runDevServer,
  type DevServerConfig,
  type PackageJsonSchemaGenerator,
} from "./internal/public/dev-server";

export { daemonStatuses, exitWhenUninstalled } from "./internal/public/daemon";

export { upgrade, type UpgradeOptions } from "./internal/public/upgrade";
export { autoUpgrade, type AutoUpgradeOptions } from "./internal/public/auto-upgrade";

export { DAEMON_ID_PREFIX } from "./internal/common/constants";
export type { DaemonRegistration, DaemonStatus, DaemonUnitKind } from "./internal/modules/daemon/interface";

export * as Cli from "./internal/public/cli";
