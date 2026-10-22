export const BASE_PACKAGE_TAG = "latest";
export const BIN_DIR = "bin";
export const CLI_CMD_NAME = "jive-library";
export const DAEMON_SOURCE_DIR = "src/daemons";
export const ENTRYPOINT_SOURCE_DIR = "src/entrypoints";
/**
 * Prefix every daemon registration carries, on every platform: the record file name, the launchd label, the
 * systemd unit and the scheduled task are all this same one string.
 *
 * It exists so Jive's own registrations are identifiable without the registry — which is the recovery path
 * for exactly the orphaned-unit problem the registry is there to prevent — and so a command that lists
 * daemons and their statuses has one thing to look for rather than three per-platform conventions.
 */
export const DAEMON_ID_PREFIX = "jive-daemon";

/** Directory under the user's home where every Jive daemon's registration record and log live. */
export const DAEMON_HOME_DIR = ".jive";
export const DAEMON_REGISTRY_SUBDIR = "daemons";
export const DAEMON_LOG_SUBDIR = "logs";
/**
 * Tells `install.cjs` to link the command targets and stop, leaving daemons unregistered.
 *
 * An argument rather than an environment variable: this is one caller telling one callee about one
 * invocation, and an ambient variable would be inherited by everything either of them spawns.
 */
export const REPAIR_ONLY_FLAG = "--repair-only";
export const INSTALL_SCRIPT = "install.cjs";
export const PACKAGE_SCHEMA_FILE = "package.schema.json";
export const LICENSE_FILE = "LICENSE";
export const LOCAL_ALIAS_SUFFIX = "-local";
export const MULTI_CALL_BINARY = "multi-call-binary";
export const NPM_PACKAGE_SPEC = "npm@^11.5.1";
export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const NPM_WEBSITE_URL = "https://www.npmjs.com";
export const OUTDIR = "dist";
export const PUBLISH_ORDER_FILE = "publish-order.json";
export const README_FILE = "README.md";
export const TARBALL_EXTENSION = ".tgz";
export const WINDOWS_EXECUTABLE_SUFFIX = ".exe";
export const WORKDIR = "build-temp";
