"use strict";
// Its literals deliberately repeat the library's constants (src/internal/common/constants.ts and
// src/internal/public/cli/parse.ts), so this shipped file stays plain, readable JS with nothing generated into it. The
// test "the library's daemon listing finds the daemon postinstall.cjs registered, with its log where the library
// expects" (postinstall.test.ts) catches any disagreement.
/**
 * The install step of every package built with jive-abstract-library that has commands or daemons. The builder copies
 * this file unchanged to the root of each such package; the package's postinstall script runs it, and each command's
 * launcher in bin/ requires it to do the same on its first run, because Bun skips postinstall for a package it does not
 * trust.
 *
 * Nothing in it is filled in per package. It reads its own package's package.json at run time: "name", the commands in
 * "bin", the platform packages in "optionalDependencies", and "jive", which the builder adds for what package.json has
 * no field for (the daemons, and the commands that set up Tab completion).
 *
 * CommonJS, not an ES module: Node 14 and 16 refuse to load an extensionless ES module in a "type": "module" package
 * (ERR_UNKNOWN_FILE_EXTENSION; Node 18.20 accepts it), and the launchers are extensionless. bin/package.json marks that
 * directory "commonjs" and this file ends in .cjs, so both load the same way on every Node and on Bun.
 */
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
const { homedir, userInfo } = require("os");
const { basename, delimiter, dirname, join } = require("path");

/** Where a built package keeps its commands: the launchers, and on macOS and Linux the hard links that replace them. */
const BIN_DIR = "bin";
/** The real program in each platform package, holding every command and daemon; it runs the one its own name says. */
const MULTI_CALL_BINARY = "multi-call-binary";
const WINDOWS_EXECUTABLE_SUFFIX = ".exe";
/** On Windows, beside the commands: the platform package version they were copied from. */
const INSTALLED_JSON = "installed.json";

/**
 * Prefix every daemon registration carries, on every platform: the record file name, the launchd label, the systemd unit
 * and the scheduled task are all this same one string.
 *
 * It exists so Jive's own registrations are identifiable without the registry, which is the recovery path for exactly
 * the orphaned-unit problem the registry is there to prevent, and so a command that lists daemons and their statuses
 * has one thing to look for rather than three per-platform conventions.
 */
const DAEMON_ID_PREFIX = "jive-daemon";
/** Directory under the user's home where every Jive daemon's registration record and log live. */
const DAEMON_HOME_DIR = ".jive";
const DAEMON_REGISTRY_SUBDIR = "daemons";
const DAEMON_LOG_SUBDIR = "logs";

/**
 * Tells this script to link the commands and stop, leaving daemons unregistered.
 *
 * An argument rather than an environment variable: this is one caller telling one callee about one invocation, and an
 * ambient variable would be inherited by everything either of them spawns.
 */
const REPAIR_ONLY_FLAG = "--repair-only";

/*
 * Hidden flags of a command built with the library's Cli, never offered by Tab or listed by --help: what shells,
 * launchers and builds call a command with. Together they are the completion protocol (COMPLETION_PROTOCOL in
 * public/cli/parse.ts). A launcher leaves Tab completion alone when the first argument is one of them.
 */
/** What a shell's Tab completion calls the command with, followed by the words typed so far. */
const COMPGEN_FLAG = "--compgen";
/** Followed by a shell's name: prints the script that registers Tab completion, which the startup line evaluates. */
const COMPLETION_SCRIPT_FLAG = "--completion";
/** Prints the completion protocol's version: how a build, or another copy of the command, learns this one speaks it. */
const COMPLETION_PROTOCOL_FLAG = "--completion-protocol";
const SET_UP_COMPLETION_FLAG = "--setup-completion";
const REMOVE_COMPLETION_FLAG = "--remove-completion";
/** What this script runs each completion command with after an install or upgrade: set up Tab completion if the user's shell lacks it. */
const SET_UP_MISSING_COMPLETION_FLAG = "--setup-completion-if-missing";
const COMPLETION_FLAGS = [
  COMPGEN_FLAG,
  COMPLETION_SCRIPT_FLAG,
  COMPLETION_PROTOCOL_FLAG,
  SET_UP_COMPLETION_FLAG,
  REMOVE_COMPLETION_FLAG,
  SET_UP_MISSING_COMPLETION_FLAG,
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

/**
 * The package at `packageDir`, from its package.json: its name, its commands in "bin" order, its platform packages, and
 * the daemons and completion commands the builder put in its "jive" field.
 */
function readPackage(packageDir) {
  const manifestPath = join(packageDir, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    fail(`Cannot read ${manifestPath}: ${error.message}`);
  }
  const jive = manifest.jive || {};
  return {
    packageDir,
    name: manifest.name,
    commands: Object.keys(manifest.bin || {}),
    platformPackages: Object.keys(manifest.optionalDependencies || {}),
    daemons: jive.daemons || [],
    completionCommands: jive.completionCommands || [],
  };
}

function installedPlatformPackage(pkg, platformPackage) {
  try {
    const manifestPath = require.resolve(`${platformPackage}/package.json`, { paths: [pkg.packageDir] });
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (!Array.isArray(manifest.os) || !Array.isArray(manifest.cpu)) return undefined;
    const binaryFile = manifest.os.includes("win32") ? `${MULTI_CALL_BINARY}${WINDOWS_EXECUTABLE_SUFFIX}` : MULTI_CALL_BINARY;
    return {
      name: platformPackage,
      os: manifest.os,
      cpu: manifest.cpu,
      binaryPath: join(dirname(manifestPath), binaryFile),
      version: manifest.version,
    };
  } catch {
    return undefined;
  }
}

/**
 * The base package has one optional dependency per platform, each holding that platform's build of every command. The
 * package manager installs the one whose "os" and "cpu" match the machine, so this uses whichever is installed rather
 * than deciding the platform again. Asking again can disagree with the package manager: on an Apple Silicon Mac, bun
 * (native) installs darwin-arm64, while an Intel build of Node running under Rosetta reports process.arch "x64".
 * @returns the path to the platform binary and the exact version of the platform package.
 */
function currentPlatformPackage(pkg) {
  const installed = pkg.platformPackages.map((name) => installedPlatformPackage(pkg, name)).filter(Boolean);
  if (installed.length === 1) return installed[0];

  // More than one is installed only when the package manager was told to (npm's --cpu and --os flags).
  const matching = installed.find((platformPackage) =>
    platformPackage.os.includes(process.platform) && platformPackage.cpu.includes(process.arch));
  if (matching) return matching;

  fail(installed.length === 0
    ? `None of ${pkg.name}'s platform packages is installed (${pkg.platformPackages.join(", ")}). Reinstall ${pkg.name}.`
    : `Several of ${pkg.name}'s platform packages are installed (${installed.map((p) => p.name).join(", ")}) and none matches ${process.platform}-${process.arch}. Reinstall ${pkg.name}.`);
}

/** The real program a command runs: on macOS and Linux its own file in bin/, once linked; on Windows the .exe beside it. */
function commandTarget(input) {
  const suffix = process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : "";
  return join(input.packageDir, BIN_DIR, `${input.command}${suffix}`);
}

function installedJsonPath(packageDir) {
  return join(packageDir, BIN_DIR, INSTALLED_JSON);
}

/**
 * Whether the Windows commands are copies of the installed platform package's version. A launcher on Windows runs every
 * time, since Windows runs a command through its .cmd shim rather than the file in bin/, so it sets up again only when
 * this says the commands are stale: after an install or upgrade the package manager skipped this script for.
 */
function commandsAreCurrent(input) {
  if (process.platform !== "win32") return false;
  const pkg = readPackage(input.packageDir);
  const platformPackage = currentPlatformPackage(pkg);
  if (!pkg.commands.every((command) => existsSync(commandTarget({ packageDir: pkg.packageDir, command })))) return false;

  try {
    const installed = JSON.parse(readFileSync(installedJsonPath(pkg.packageDir), "utf-8"));
    return installed.version === platformPackage.version;
  } catch {
    return false;
  }
}

function temporaryPath(targetPath) {
  return `${targetPath}.${process.pid}.${Date.now()}.tmp${process.platform === "win32" ? WINDOWS_EXECUTABLE_SUFFIX : ""}`;
}

function linkOrCopyFirstExecutable(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = temporaryPath(targetPath);
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

  const tempPath = temporaryPath(targetPath);
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

/**
 * Points every command at the installed platform package's program: on macOS and Linux each launcher in bin/ is
 * replaced by a hard link to it, so later runs start the program directly; on Windows a .exe beside each launcher, with
 * installed.json recording the version, unless the commands are already that version's.
 */
function linkCommands(pkg) {
  const platformPackage = currentPlatformPackage(pkg);
  if (commandsAreCurrent({ packageDir: pkg.packageDir })) return;

  const firstTargetPath = commandTarget({ packageDir: pkg.packageDir, command: pkg.commands[0] });
  linkOrCopyFirstExecutable(platformPackage.binaryPath, firstTargetPath);

  for (const command of pkg.commands.slice(1)) {
    hardLinkCommandTarget(firstTargetPath, commandTarget({ packageDir: pkg.packageDir, command }));
  }

  if (process.platform === "win32") {
    writeFileSync(installedJsonPath(pkg.packageDir), `${JSON.stringify({ version: platformPackage.version }, null, 2)}\n`);
  }
}

/* ------------------------------------------------------------------ Tab completion ---------- */

/**
 * Asks each command built with Cli to set up Tab completion if the user's shell lacks it. The command decides everything
 * (which shell, which file, whether this copy is the one the user's PATH runs, whether it was turned off) and says on
 * stderr what it set up; its stdout is dropped, since the caller of the command the user typed may be reading this
 * process's stdout.
 */
function setUpMissingCompletion(pkg) {
  for (const command of pkg.completionCommands) {
    const result = spawnSync(commandTarget({ packageDir: pkg.packageDir, command }), [SET_UP_MISSING_COMPLETION_FLAG], { stdio: ["ignore", "ignore", "inherit"] });
    if (result.error) console.error(`Could not check Tab completion for ${command}: ${result.error.message}`);
  }
}

/* ------------------------------------------------------------------ daemon registration ---------- */

/**
 * Registering a package's daemons with the operating system so they start at login.
 *
 * As the user, not system-wide: a daemon here acts for one user, with access to that user's keychain, SSH agent and home
 * directory, and a system-wide service would have none of those. On macOS and Windows it starts at login; on Linux at
 * boot, because the user is made to linger (registerSystemd). On Windows that is a scheduled task rather than a service
 * for the same reason: a service runs in session 0, isolated from the desktop the user is actually logged into.
 *
 * This runs here, in plain JavaScript, because it has to run on a machine that has only just received the package. The
 * daemon binary cannot register itself: nothing has started it yet.
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
  return join(registryDir(), `${id}.json`);
}

/**
 * The tree this copy of the package was installed into, which is where its daemons should work.
 *
 * Derived from the path rather than from INIT_CWD, which npm sets and Bun does not, and which answers the wrong question
 * anyway: where the install was *typed*, not what it installed into. Walking out of the enclosing node_modules answers
 * it for a project install and a global one alike, and a package with no node_modules above it (one built and installed
 * in place) is its own root.
 */
function installRoot(pkg) {
  let dir = pkg.packageDir;
  while (true) {
    if (basename(dir) === "node_modules") return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return pkg.packageDir;
    dir = parent;
  }
}

/** One id segment: dots separate segments, so a dot inside a name cannot be left as one. */
function idSegment(value) {
  return value.replace(/[^A-Za-z0-9-]+/g, "-");
}

/**
 * Scope and name get a segment each, and an unscoped package gets "_" where its scope would be.
 *
 * Joining them with a dash instead would not be reversible: `@ozyman42/ozy-cli` and a package actually named
 * `ozyman42-ozy-cli` would produce the same text. "_" is safe as the marker because npm forbids a scope or name from
 * starting with it, so no real scope can collide with it.
 */
function packageSegments(packageName) {
  if (!packageName.startsWith("@")) return ["_", idSegment(packageName)];
  const separator = packageName.indexOf("/");
  return [
    idSegment(packageName.slice(1, separator)),
    idSegment(packageName.slice(separator + 1)),
  ];
}

/**
 * The id a registration is replaced at: the package's name, the daemon's name, and a digest of the directory this copy
 * of the package was installed into.
 *
 * **Where the package is installed is what decides how many of its daemons exist.** Reinstalling or upgrading the same
 * copy keeps the id, so the registration is replaced; a second copy installed somewhere else gets its own id, so each
 * project that installs its own copy gets its own daemon and a globally installed copy gets exactly one.
 *
 * An earlier version had each daemon declare `local` or `global` in the manifest instead. That was a second source of
 * truth that contradicted the real one: a `global` daemon installed into two projects registered once, pointing at
 * whichever installed last, so uninstalling the second took the first project's daemon away, the very failure `local`
 * existed to prevent.
 */
function daemonId(pkg, name) {
  const [scope, packageName] = packageSegments(pkg.name);
  const installDigest = createHash("sha256").update(pkg.packageDir).digest("hex").slice(0, 10);
  return `${DAEMON_ID_PREFIX}.${scope}.${packageName}.${idSegment(name)}.${installDigest}`;
}

function run(argv, allowFailure) {
  const result = spawnSync(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
  if (result.error || result.status !== 0) {
    if (!allowFailure) {
      const detail = result.error ? result.error.message : String(result.stderr || "").trim();
      console.error(`  ${argv.join(" ")} failed: ${detail}`);
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
 * launchd. KeepAlive on SuccessfulExit=false restarts a daemon that crashes but respects one that exits zero, which is
 * how a daemon that has removed its own registration stays stopped.
 */
function registerLaunchd(input) {
  const { id, executable, workingDirectory, logPath } = input;
  // The id verbatim, rather than a reverse-DNS label: one string names this daemon on every platform.
  const label = id;
  const agentsDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(agentsDir, `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  const unregister = ["launchctl", "bootout", `${domain}/${label}`];

  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(plistPath, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xmlEscape(label)}</string>`,
    `  <key>ProgramArguments</key><array><string>${xmlEscape(executable)}</string></array>`,
    `  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    `  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>`,
    "  <key>ProcessType</key><string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n"));

  const start = () => {
    // Booting out first: bootstrap refuses a label that is already loaded, and a reinstall is the common case. bootout
    // returns before launchd has finished stopping a daemon that is running, and bootstrap is refused until it has
    // ("Bootstrap failed: 5"), so a reinstall over a live daemon left it stopped until the next login. Retry for a few
    // seconds; only the last failure is reported.
    run(unregister, true);
    const attempts = 20;
    let started = false;
    for (let attempt = 1; attempt <= attempts && !started; attempt++) {
      if (attempt > 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      started = run(["launchctl", "bootstrap", domain, plistPath], attempt < attempts);
    }
    return started;
  };
  return { kind: "launchd", unit: label, files: [plistPath], unregister, start };
}

/**
 * systemd user units. `--user` rather than system units, for the same reason launchd gets a LaunchAgent.
 *
 * A user's systemd manager, and every unit in it, stops when their last session ends and starts again at their next
 * login, unless the user lingers. On a server nobody stays logged in to, the daemons would be down most of the time, so
 * the user is made to linger, which starts their manager at boot. systemd lets every user set their own (polkit's
 * org.freedesktop.login1.set-self-linger), with no password. Removing a registration leaves lingering on: something
 * else of the user's may rely on it, and it costs only their manager running.
 */
function registerSystemd(input) {
  const { id, name, packageName, executable, workingDirectory, logPath } = input;
  const unit = `${id}.service`;
  const unitDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "systemd", "user");
  const unitPath = join(unitDir, unit);
  const unregister = ["systemctl", "--user", "disable", "--now", unit];

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, [
    "[Unit]",
    `Description=Jive daemon ${name} for ${packageName}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${executable}`,
    `WorkingDirectory=${workingDirectory}`,
    "Restart=on-failure",
    "RestartSec=5",
    `StandardOutput=append:${logPath}`,
    `StandardError=append:${logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n"));

  const start = () => {
    if (!run(["loginctl", "enable-linger", "--no-ask-password"], false)) {
      console.error(`  ${unit} stops whenever you have no session open; \`sudo loginctl enable-linger ${userInfo().username}\` keeps it running`);
    }
    run(["systemctl", "--user", "daemon-reload"], true);
    // Restart rather than `enable --now`, which leaves a running daemon on the executable it started from: after an
    // upgrade that is the old version, held open after its file was replaced.
    return run(["systemctl", "--user", "enable", unit], false)
      && run(["systemctl", "--user", "restart", unit], false);
  };
  return { kind: "systemd", unit, files: [unitPath], unregister, start };
}

/**
 * Windows Task Scheduler, through a .cmd shim.
 *
 * The shim exists because schtasks can set neither a working directory nor environment variables, and it also supplies
 * the restart-on-crash behaviour the other two platforms get from their service manager: an ONLOGON task starts its
 * program once and does not watch it. The loop mirrors launchd's KeepAlive, so a daemon that exits zero after removing
 * itself is not restarted.
 */
function registerScheduledTask(input) {
  const { id, executable, workingDirectory, logPath } = input;
  const taskName = id;
  const shimPath = join(registryDir(), `${id}.cmd`);
  const unregister = ["schtasks", "/Delete", "/F", "/TN", taskName];

  writeFileSync(shimPath, [
    "@echo off",
    `cd /d "${workingDirectory}"`,
    ":jive_loop",
    `"${executable}" >> "${logPath}" 2>&1`,
    "if %ERRORLEVEL% EQU 0 goto :eof",
    "timeout /t 5 /nobreak > nul",
    "goto jive_loop",
    "",
  ].join("\r\n"));

  // An ONLOGON task waits for the next login, so it is also run now, as launchd and systemd start theirs.
  const start = () => run([
    "schtasks", "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", taskName,
    "/TR", `"${shimPath}"`,
    "/RL", "LIMITED",
  ], false) && run(["schtasks", "/Run", "/TN", taskName], false);
  return { kind: "scheduled-task", unit: taskName, files: [shimPath], unregister, start };
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
  console.log(`Removing daemon ${record.id} (${reason})`);
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
 * Three cases, all of which would otherwise leave the operating system starting a missing or unwanted executable at
 * every login: a daemon this version of the package no longer has, a copy of the package whose directory is gone, and a
 * registration of this very copy under an id we no longer use, which is what makes a change to the id scheme replace
 * its registrations instead of doubling them.
 *
 * Only this package's own registrations are considered, by name, so another package's daemon is never touched; and only
 * this copy's, except where the copy itself has been deleted.
 */
function pruneRemovedDaemons(pkg, currentIds) {
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
    if (!record || record.packageName !== pkg.name) continue;

    const reason =
      !pkg.daemons.includes(record.name) ? `no longer part of ${pkg.name}`
      : !existsSync(record.packageDir) ? `${record.packageDir} is gone`
      : record.packageDir === pkg.packageDir && !currentIds.includes(record.id) ? "superseded by a new id"
      : undefined;
    if (reason === undefined) continue;

    removeRegistration(record, reason);
    rmSync(path, { force: true });
  }
}

function registerDaemons(pkg, repairOnly) {
  // Two reasons not to register. The caller asked for repair alone: the local deploy does, because its install exists so
  // the launcher can resolve a platform package, not because anyone chose to install that copy. Or this is a build
  // agent, which installs a package to run one command and is then discarded: registering something to start at a login
  // that will never happen is pure noise, and in a container it fails outright.
  const skip = repairOnly ? `${REPAIR_ONLY_FLAG} was passed`
    : process.env.CI ? "CI is set"
    : undefined;
  const names = skip === undefined ? pkg.daemons : [];

  // Pruning first, and with no current ids when skipping: declining to run daemons here has to also take away any this
  // copy registered earlier, or one such install would leave them starting at every login forever. Before the early
  // return below, too: a version that drops its last daemon still has to take the previous version's registration away,
  // and the record carries everything undoing it needs.
  pruneRemovedDaemons(pkg, names.map((name) => daemonId(pkg, name)));
  if (skip !== undefined) {
    if (pkg.daemons.length > 0) console.log(`${skip}: not registering ${pkg.daemons.join(", ")}`);
    return;
  }
  if (names.length === 0) return;

  const registrar = DAEMON_REGISTRARS[process.platform];
  if (!registrar) {
    console.log(`No daemon support for ${process.platform}: ${names.join(", ")} will not start automatically`);
    return;
  }

  mkdirSync(registryDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });

  for (const name of names) {
    const id = daemonId(pkg, name);
    const path = recordPath(id);
    const previous = readRecord(path);
    const workingDirectory = installRoot(pkg);
    const executable = commandTarget({ packageDir: pkg.packageDir, command: name });
    const logPath = join(logDir(), `${id}.log`);

    console.log(
      `${previous ? "Replacing existing" : "Creating"} daemon ${id}`
      + ` (${name} from ${pkg.name}) in ${workingDirectory}`,
    );

    // The registrar writes its unit file and says how it will be loaded; the record goes down, whole, before the unit is
    // loaded, because loading it starts the daemon, and the first thing the daemon does is read this file to find out
    // how it was registered. Whole, so an install stopped at any point leaves either the previous record or this one,
    // never one missing the kind and unit a listing command asks the platform about.
    const registration = registrar({ id, name, packageName: pkg.name, executable, workingDirectory, logPath });
    writeFileSync(path, `${JSON.stringify({
      id,
      name,
      packageName: pkg.name,
      packageDir: pkg.packageDir,
      workingDirectory,
      executable,
      registeredAt: new Date().toISOString(),
      searchPath: [...new Set((process.env.PATH || "").split(delimiter).filter(Boolean))].join(delimiter),
      kind: registration.kind,
      unit: registration.unit,
      logPath,
      files: [...registration.files, path],
      unregister: registration.unregister,
    }, null, 2)}\n`);

    if (!registration.start()) {
      console.error(`  ${id} is registered but could not be started; it will start at your next login`);
    }
  }
}

/**
 * Sets up the package at `packageDir`: links its commands to the installed platform package's program, registers its
 * daemons (or, with `repairOnly`, removes this copy's registrations), and with `setUpCompletion` asks its completion
 * commands to set up Tab completion.
 *
 * Every step replaces what an earlier run did rather than assuming it is the first: package.json's postinstall names
 * this file, and a package manager may run it again at any later install (bun reruns a trusted folder dependency's on
 * later global installs).
 */
function setUp(input) {
  const pkg = readPackage(input.packageDir);
  linkCommands(pkg);
  registerDaemons(pkg, input.repairOnly);
  if (input.setUpCompletion) setUpMissingCompletion(pkg);
}

// What a command's launcher in bin/ uses.
module.exports = {
  COMPLETION_FLAGS,
  commandTarget,
  commandsAreCurrent,
  setUp,
};

// Run as package.json's postinstall (`node ./postinstall.cjs`); a launcher only uses the exports above.
if (require.main === module) {
  const repairOnly = process.argv.includes(REPAIR_ONLY_FLAG);
  setUp({ packageDir: realpathSync(__dirname), repairOnly, setUpCompletion: !repairOnly });
}
