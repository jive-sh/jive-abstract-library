/**
 * The public surface of this template.
 *
 * Three things live here: the shape a package.json must have to be built by this template, the release
 * helpers a package's own deploy script may need, and the watch daemon every Jive template runs. A
 * template that derives from this one supplies its `genPackageJsonSchema` and gets the rest unchanged.
 */

export {
  ensureNpm,
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
  REQUIRED_SCRIPTS,
  RESERVED_ENVIRONMENTS,
  isEnvironment,
  makeLibrarySchema,
  makePackageJsonSchema,
  type CicdConfig,
  type LibraryConfig,
  type PackageJson,
} from "./internal/public/manifest";

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
