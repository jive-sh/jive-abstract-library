/**
 * The launcher every generated command is written from, inlined rather than read from disk.
 *
 * It used to be a `.ejs` file loaded at build time with a path resolved against the package being built —
 * which worked only while this tool was building itself, and broke for the first package that was not this
 * one. Resolving it against this module instead would not have fixed it either: the published CLI is a
 * Bun-compiled binary, so there is no `.ejs` on disk to read at all.
 *
 * It is still rendered through EJS; only where the source comes from has changed.
 */
export const COMMAND_LAUNCHER_TEMPLATE = `#!/usr/bin/env node
"use strict";
// CommonJS, not an ES module: a launcher is an extensionless file, and Node 14 and 16 refuse to load an
// extensionless ES module in a "type": "module" package (ERR_UNKNOWN_FILE_EXTENSION; Node 18.20 accepts it). bin/package.json marks this directory
// "commonjs", and the install script is install.cjs, so both load the same way on every Node and on Bun.
const { spawnSync } = require("child_process");
const {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require("fs");
const { createHash } = require("crypto");
const { homedir } = require("os");
const { basename, delimiter, dirname, join } = require("path");

const PLATFORM_MAP = <%- json(platformMap) %>;
const PLATFORM_PACKAGES = <%- json(platformPackages) %>;
const PLATFORM_BINARIES = <%- json(platformBinaries) %>;
const COMMANDS = <%- json(commandNames) %>;
const PACKAGE_NAME = <%- json(packageName) %>;
// Every src/daemons/ entry. The build refuses to produce a package where this disagrees with the files,
// so it needs no checking here.
const DAEMONS = <%- json(daemons) %>;
const DAEMON_ID_PREFIX = <%- json(daemonIdPrefix) %>;
const DAEMON_HOME_DIR = <%- json(daemonHomeDir) %>;
const DAEMON_REGISTRY_SUBDIR = <%- json(daemonRegistrySubdir) %>;
const DAEMON_LOG_SUBDIR = <%- json(daemonLogSubdir) %>;
const REPAIR_ONLY_FLAG = <%- json(repairOnlyFlag) %>;
const BIN_DIR = <%- json(binDir) %>;
const INSTALL_SCRIPT = <%- json(installScript) %>;
// Root install.cjs repairs command targets; bin launchers repair and then execute.
const IS_INSTALL_SCRIPT = <%- json(isInstallScript) %>;
const WINDOWS_EXECUTABLE_SUFFIX = <%- json(windowsExecutableSuffix) %>;
const INSTALLED_JSON = "installed.json";

// The real path: reached through a link in a bin directory, the package is wherever the link points.
const launcherPath = realpathSync(__filename);
const launcherDir = dirname(launcherPath);
const packageDir = IS_INSTALL_SCRIPT ? launcherDir : dirname(launcherDir);
const commandTargetDir = join(packageDir, BIN_DIR);
const rootInstallScriptPath = join(packageDir, INSTALL_SCRIPT);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function installedPlatformPackage(platformKey) {
  try {
    const packageJsonPath = require.resolve(\`\${PLATFORM_PACKAGES[platformKey]}/package.json\`);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return {
      platformKey,
      binaryPath: join(dirname(packageJsonPath), PLATFORM_BINARIES[platformKey]),
      version: packageJson.version,
    };
  } catch {
    return undefined;
  }
}

/**
 * The base package has one optional dependency per platform, each holding that platform's build of every
 * command. The package manager installs the one whose "os" and "cpu" match the machine, so the launcher
 * uses whichever is installed rather than deciding the platform again. Asking again can disagree with the
 * package manager: on an Apple Silicon Mac, bun (native) installs darwin-arm64, while an Intel build of
 * Node running under Rosetta reports process.arch "x64".
 * @returns the path to the platform binary and the exact version of the platform package.
 */
function currentPlatformPackage() {
  const installed = Object.keys(PLATFORM_PACKAGES).map(installedPlatformPackage).filter(Boolean);
  if (installed.length === 1) return installed[0];

  const reported = PLATFORM_MAP[\`\${process.platform}-\${process.arch}\`];
  const matching = installed.find((platformPackage) => platformPackage.platformKey === reported);
  // More than one is installed only when the package manager was told to (npm's --cpu and --os flags).
  if (matching) return matching;

  fail(installed.length === 0
    ? \`None of \${PACKAGE_NAME}'s platform packages is installed (\${Object.values(PLATFORM_PACKAGES).join(", ")}). Reinstall \${PACKAGE_NAME}.\`
    : \`Several of \${PACKAGE_NAME}'s platform packages are installed (\${installed.map((p) => PLATFORM_PACKAGES[p.platformKey]).join(", ")}) and none matches \${process.platform}-\${process.arch}. Reinstall \${PACKAGE_NAME}.\`);
}

function commandTargetPath(command) {
  const suffix = process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : "";
  return join(commandTargetDir, \`\${command}\${suffix}\`);
}

function installedJsonPath() {
  return join(commandTargetDir, INSTALLED_JSON);
}

function windowsTargetsAreCurrent(version) {
  if (process.platform !== "win32") return false;
  if (!COMMANDS.every((command) => existsSync(commandTargetPath(command)))) return false;

  try {
    const installed = JSON.parse(readFileSync(installedJsonPath(), "utf-8"));
    return installed.version === version;
  } catch {
    return false;
  }
}

function linkOrCopyFirstExecutable(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = \`\${targetPath}.\${process.pid}.\${Date.now()}.tmp\${process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : ""}\`;
  rmSync(tempPath, { force: true });

  try {
    try {
      linkSync(sourcePath, tempPath);
    } catch {
      copyFileSync(sourcePath, tempPath);
    }

    chmodSync(tempPath, 0o755);
    rmSync(targetPath, { force: true });
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function hardLinkCommandTarget(sourcePath, targetPath) {
  if (sourcePath === targetPath) return;

  const tempPath = \`\${targetPath}.\${process.pid}.\${Date.now()}.tmp\${process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : ""}\`;
  rmSync(tempPath, { force: true });

  try {
    linkSync(sourcePath, tempPath);
    chmodSync(tempPath, 0o755);
    rmSync(targetPath, { force: true });
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function repairCommandTargets() {
  const platformPackage = currentPlatformPackage();

  if (windowsTargetsAreCurrent(platformPackage.version)) {
    return;
  }

  const firstTargetPath = commandTargetPath(COMMANDS[0]);
  linkOrCopyFirstExecutable(platformPackage.binaryPath, firstTargetPath);

  for (const command of COMMANDS.slice(1)) {
    hardLinkCommandTarget(firstTargetPath, commandTargetPath(command));
  }

  if (process.platform === "win32") {
    writeFileSync(installedJsonPath(), \`\${JSON.stringify({ version: platformPackage.version }, null, 2)}\\n\`);
  }
}

function runExecutable(executablePath) {
  const result = spawnSync(executablePath, process.argv.slice(2), { stdio: "inherit" });

  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function removeInstallScript() {
  try {
    rmSync(rootInstallScriptPath, { force: true });
    // TODO: should we also remove the postinstall script line from package.json?
  } catch {
    // Cleanup is best-effort; failing to remove install.cjs should not fail package installation.
  }
}

/* ------------------------------------------------------------------ daemon registration ---------- */

/**
 * Registering a package's daemons with the operating system so they start at login.
 *
 * At login, not at boot: a daemon here acts for one user, with access to that user's keychain, SSH agent
 * and home directory, and a system-wide service would have none of those. On Windows that is a scheduled
 * task rather than a service for the same reason — a service runs in session 0, isolated from the desktop
 * the user is actually logged into.
 *
 * This runs in the installer, which is plain JavaScript, because it has to run on a machine that has only
 * just received the package. The daemon binary cannot register itself: nothing has started it yet.
 */

function jiveHome() {
  return join(homedir(), DAEMON_HOME_DIR);
}

function registryDir() {
  return join(jiveHome(), DAEMON_REGISTRY_SUBDIR);
}

function logDir() {
  return join(jiveHome(), DAEMON_LOG_SUBDIR);
}

function recordPath(id) {
  return join(registryDir(), \`\${id}.json\`);
}

/**
 * The tree this copy of the package was installed into, which is where its daemons should work.
 *
 * Derived from the path rather than from INIT_CWD, which npm sets and Bun does not, and which answers the
 * wrong question anyway: where the install was *typed*, not what it installed into. Walking out of the
 * enclosing node_modules answers it for a project install and a global one alike, and a package with no
 * node_modules above it — one built and installed in place — is its own root.
 */
function installRoot() {
  let dir = packageDir;
  while (true) {
    if (basename(dir) === "node_modules") return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return packageDir;
    dir = parent;
  }
}

/**
 * The id a registration is replaced at: the package's name, the daemon's name, and a digest of the
 * directory this copy of the package was installed into.
 *
 * **Where the package is installed is what decides how many of its daemons exist.** Reinstalling or
 * upgrading the same copy keeps the id, so the registration is replaced; a second copy installed somewhere
 * else gets its own id, so each project that installs its own copy gets its own daemon and a globally
 * installed copy gets exactly one.
 *
 * An earlier version had each daemon declare \`local\` or \`global\` in the manifest instead. That was a
 * second source of truth that contradicted the real one: a \`global\` daemon installed into two projects
 * registered once, pointing at whichever installed last, so uninstalling the second took the first
 * project's daemon away — the very failure \`local\` existed to prevent.
 */
/** One id segment: dots separate segments, so a dot inside a name cannot be left as one. */
function idSegment(value) {
  return value.replace(/[^A-Za-z0-9-]+/g, "-");
}

/**
 * Scope and name get a segment each, and an unscoped package gets "_" where its scope would be.
 *
 * Joining them with a dash instead would not be reversible: \`@ozyman42/ozy-cli\` and a package actually
 * named \`ozyman42-ozy-cli\` would produce the same text. "_" is safe as the marker because npm forbids a
 * scope or name from starting with it, so no real scope can collide with it.
 */
function packageSegments() {
  if (!PACKAGE_NAME.startsWith("@")) return ["_", idSegment(PACKAGE_NAME)];
  const separator = PACKAGE_NAME.indexOf("/");
  return [
    idSegment(PACKAGE_NAME.slice(1, separator)),
    idSegment(PACKAGE_NAME.slice(separator + 1)),
  ];
}

function daemonId(name) {
  const [scope, packageName] = packageSegments();
  const installDigest = createHash("sha256").update(packageDir).digest("hex").slice(0, 10);
  return \`\${DAEMON_ID_PREFIX}.\${scope}.\${packageName}.\${idSegment(name)}.\${installDigest}\`;
}

function run(argv, allowFailure) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
  if (result.error || result.status !== 0) {
    if (!allowFailure) {
      const detail = result.error ? result.error.message : String(result.stderr || "").trim();
      console.error(\`  \${argv.join(" ")} failed: \${detail}\`);
    }
    return false;
  }
  return true;
}

function xmlEscape(value) {
  return String(value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;");
}

/**
 * launchd. KeepAlive on SuccessfulExit=false restarts a daemon that crashes but respects one that exits
 * zero, which is how a daemon that has removed its own registration stays stopped.
 */
function registerLaunchd(id, name, executable, workingDirectory, logPath) {
  // The id verbatim, rather than a reverse-DNS label: one string names this daemon on every platform.
  const label = id;
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, \`\${label}.plist\`);
  const domain = \`gui/\${process.getuid()}\`;
  const unregister = ["launchctl", "bootout", \`\${domain}/\${label}\`];

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(plistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    \`  <key>Label</key><string>\${xmlEscape(label)}</string>\`,
    \`  <key>ProgramArguments</key><array><string>\${xmlEscape(executable)}</string></array>\`,
    \`  <key>WorkingDirectory</key><string>\${xmlEscape(workingDirectory)}</string>\`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    \`  <key>StandardOutPath</key><string>\${xmlEscape(logPath)}</string>\`,
    \`  <key>StandardErrorPath</key><string>\${xmlEscape(logPath)}</string>\`,
    "  <key>ProcessType</key><string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\\n"));

  // Booting out first: bootstrap refuses a label that is already loaded, and a reinstall is the common case.
  // bootout returns before launchd has finished stopping a daemon that is running, and bootstrap is refused
  // until it has ("Bootstrap failed: 5"), so a reinstall over a live daemon left it stopped until the next
  // login. Retry for a few seconds; only the last failure is reported.
  run(unregister, true);
  const attempts = 20;
  let started = false;
  for (let attempt = 1; attempt <= attempts && !started; attempt++) {
    if (attempt > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    started = run(["launchctl", "bootstrap", domain, plistPath], attempt < attempts);
  }
  return { kind: "launchd", unit: label, files: [plistPath], unregister, started };
}

/** systemd user units. \`--user\` rather than system units, for the same reason launchd gets a LaunchAgent. */
function registerSystemd(id, name, executable, workingDirectory, logPath) {
  const unit = \`\${id}.service\`;
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const unitPath = join(unitDir, unit);
  const unregister = ["systemctl", "--user", "disable", "--now", unit];

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, [
    "[Unit]",
    \`Description=Jive daemon \${name} for \${PACKAGE_NAME}\`,
    "",
    "[Service]",
    "Type=simple",
    \`ExecStart=\${executable}\`,
    \`WorkingDirectory=\${workingDirectory}\`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\\n"));

  run(["systemctl", "--user", "daemon-reload"], true);
  // Restart rather than \`enable --now\`, which leaves a running daemon on the executable it started from:
  // after an upgrade that is the old version, held open after its file was replaced.
  const started = run(["systemctl", "--user", "enable", unit], false)
    && run(["systemctl", "--user", "restart", unit], false);
  return { kind: "systemd", unit, files: [unitPath], unregister, started };
}

/**
 * Windows Task Scheduler, through a .cmd shim.
 *
 * The shim exists because schtasks can set neither a working directory nor environment variables, and it
 * also supplies the restart-on-crash behaviour the other two platforms get from their service manager: an
 * ONLOGON task starts its program once and does not watch it. The loop mirrors launchd's KeepAlive, so a
 * daemon that exits zero after removing itself is not restarted.
 */
function registerScheduledTask(id, name, executable, workingDirectory, logPath) {
  const taskName = id;
  const shimPath = join(registryDir(), \`\${id}.cmd\`);
  const unregister = ["schtasks", "/Delete", "/F", "/TN", taskName];

  writeFileSync(shimPath, [
    "@echo off",
    \`cd /d "\${workingDirectory}"\`,
    ":jive_loop",
    \`"\${executable}" >> "\${logPath}" 2>&1\`,
    "if %ERRORLEVEL% EQU 0 goto :eof",
    "timeout /t 5 /nobreak > nul",
    "goto jive_loop",
    "",
  ].join("\\r\\n"));

  // An ONLOGON task waits for the next login, so it is also run now, as launchd and systemd start theirs.
  const started = run([
    "schtasks", "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", taskName,
    "/TR", \`"\${shimPath}"\`,
    "/RL", "LIMITED",
  ], false) && run(["schtasks", "/Run", "/TN", taskName], false);
  return { kind: "scheduled-task", unit: taskName, files: [shimPath], unregister, started };
}

const DAEMON_REGISTRARS = {
  darwin: registerLaunchd,
  linux: registerSystemd,
  win32: registerScheduledTask,
};

function readRecord(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function removeRegistration(record, reason) {
  console.log(\`Removing daemon \${record.id} (\${reason})\`);
  if (Array.isArray(record.unregister) && record.unregister.length > 0) {
    run(record.unregister, true);
  }
  for (const file of record.files || []) {
    rmSync(file, { force: true });
  }
}

/**
 * Drops this package's registrations that should no longer exist.
 *
 * Three cases, all of which would otherwise leave the operating system starting a missing or unwanted
 * executable at every login: a daemon this version of the package no longer has, a copy of the package
 * whose directory is gone, and a registration of this very copy under an id we no longer use — which is
 * what makes a change to the id scheme replace its registrations instead of doubling them.
 *
 * Only this package's own registrations are considered, by name, so another package's daemon is never
 * touched; and only this copy's, except where the copy itself has been deleted.
 */
function pruneRemovedDaemons(currentIds) {
  let entries;
  try {
    entries = readdirSync(registryDir());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(registryDir(), entry);
    const record = readRecord(path);
    if (!record || record.packageName !== PACKAGE_NAME) continue;

    const reason =
      !DAEMONS.includes(record.name) ? \`no longer part of \${PACKAGE_NAME}\`
      : !existsSync(record.packageDir) ? \`\${record.packageDir} is gone\`
      : record.packageDir === packageDir && !currentIds.includes(record.id) ? "superseded by a new id"
      : undefined;
    if (reason === undefined) continue;

    removeRegistration(record, reason);
    rmSync(path, { force: true });
  }
}

function registerDaemons() {
  // Two reasons not to register. The caller asked for repair alone — the local deploy does, because its
  // install exists so the launcher can resolve a platform package, not because anyone chose to install
  // that copy. Or this is a build agent, which installs a package to run one command and is then
  // discarded: registering something to start at a login that will never happen is pure noise, and in a
  // container it fails outright.
  const skip = IS_INSTALL_SCRIPT && process.argv.includes(REPAIR_ONLY_FLAG) ? \`\${REPAIR_ONLY_FLAG} was passed\`
    : process.env.CI ? "CI is set"
    : undefined;
  const names = skip === undefined ? DAEMONS : [];

  // Pruning first, and with no current ids when skipping: declining to run daemons here has to also take
  // away any this copy registered earlier, or one such install would leave them starting at every login
  // forever. Before the early return below, too — a version that drops its last daemon still has to take
  // the previous version's registration away, and the record carries everything undoing it needs.
  pruneRemovedDaemons(names.map(daemonId));
  if (skip !== undefined) {
    if (DAEMONS.length > 0) console.log(\`\${skip} — not registering \${DAEMONS.join(", ")}\`);
    return;
  }
  if (names.length === 0) return;

  const registrar = DAEMON_REGISTRARS[process.platform];
  if (!registrar) {
    console.log(\`No daemon support for \${process.platform} — \${names.join(", ")} will not start automatically\`);
    return;
  }

  mkdirSync(registryDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });

  for (const name of names) {
    const id = daemonId(name);
    const path = recordPath(id);
    const previous = readRecord(path);
    const workingDirectory = installRoot();
    const executable = commandTargetPath(name);
    const logPath = join(logDir(), \`\${id}.log\`);

    console.log(
      \`\${previous ? "Replacing existing" : "Creating"} daemon \${id}\`
      + \` (\${name} from \${PACKAGE_NAME}) in \${workingDirectory}\`,
    );

    // The record goes down before the unit is loaded, because loading it starts the daemon, and the first
    // thing the daemon does is read this file to find out how it was registered.
    const pending = {
      id,
      name,
      packageName: PACKAGE_NAME,
      packageDir,
      workingDirectory,
      executable,
      registeredAt: new Date().toISOString(),
      searchPath: [...new Set((process.env.PATH || "").split(delimiter).filter(Boolean))].join(delimiter),
      files: [path],
      unregister: previous && previous.unregister ? previous.unregister : [],
    };
    writeFileSync(path, \`\${JSON.stringify(pending, null, 2)}\\n\`);

    const outcome = registrar(id, name, executable, workingDirectory, logPath);
    // kind and unit are recorded for the sake of reading a daemon's status later: they are what a listing
    // command has to ask the platform about, and only the installer knows which registrar ran.
    writeFileSync(path, \`\${JSON.stringify({
      ...pending,
      kind: outcome.kind,
      unit: outcome.unit,
      logPath,
      files: [...outcome.files, path],
      unregister: outcome.unregister,
    }, null, 2)}\\n\`);

    if (!outcome.started) {
      console.error(\`  \${id} is registered but could not be started; it will start at your next login\`);
    }
  }
}

repairCommandTargets();
registerDaemons();
removeInstallScript();
if (!IS_INSTALL_SCRIPT) {
  const commandName = basename(launcherPath);
  runExecutable(commandTargetPath(commandName));
}
`;
