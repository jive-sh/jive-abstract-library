import { Effect, Layer, Logger, Option, Result, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { stderrLogger } from "../common/logger";
import { libraryModules, type LibraryModules } from "../modules";
import { DaemonImpl } from "../modules/daemon/impl";
import type { DaemonRegistration } from "../modules/daemon/interface";
import { platformDistTag, platformVersion } from "../modules/deployer/versions";
import { InstallRun, type Install } from "../modules/installed-package/interface";
import { LATEST_ENVIRONMENT } from "./manifest";
import { installedPackageLayer } from "./upgrade";

/**
 * Keeps an installed package on its latest version, from a process that runs for a long time: a daemon calls
 * this once at startup.
 *
 * Every 5 minutes it asks the package manager that installed the package for its dist-tags, so the
 * registry that manager is configured for is the one asked. When `latest` is newer than the installed
 * version, and this machine's platform build of it is published too (`latest-<platform>` names it), it
 * installs that version the way `upgrade` does. Installing re-registers the package's daemons, which
 * restarts this one on the new version, so the install runs in a process of its own that survives the
 * restart (see `InstallRun.Detached`). On Windows, whose running executables cannot be replaced, this
 * process exits for the install to proceed, and the install script starts the daemon again.
 *
 * Fire and forget, like `exitWhenUninstalled`. A process not inside an install of the package (a build run
 * from a checkout) says so once and is never upgraded. A failed check or install is logged and retried at
 * the next check; the same failure twice in a row is logged once.
 */

export interface AutoUpgradeOptions {
  /** The package to keep upgraded, e.g. `@jive-sh/skill-sync`. */
  readonly packageName: string;
  /** The running command. Defaults to this process's executable, which is right for a compiled daemon. */
  readonly commandPath?: string;
}

const CHECK_INTERVAL = "5 minutes";

const layer = pipe(
  DaemonImpl.Layer,
  Layer.provideMerge(installedPackageLayer),
) satisfies Layer.Layer<any, any, never>;

export function autoUpgrade(options: AutoUpgradeOptions): void {
  Effect.runFork(pipe(
    effunct(keepUpgraded)(options),
    Effect.provide(layer),
    Effect.provide(Logger.layer([stderrLogger])),
    // A daemon must not die because its own housekeeping failed; its job is whatever else it was started for.
    Effect.catchCause((cause) => Effect.log(`Stopped upgrading ${options.packageName} automatically: ${String(cause)}`)),
  ));
}

/** What one check leaves for the next. */
interface Progress {
  /** The last failure or wait logged, so a repeat of it is not logged again. */
  lastReport: string;
  /** A version installed while this process was not restarted onto it, so it is not installed again. */
  installedWithoutRestart: Option.Option<string>;
}

type Requirements = LibraryModules.InstalledPackage | LibraryModules.Daemon | LibraryModules.OSPlatform;

function* keepUpgraded(options: AutoUpgradeOptions): EffectGen<void, string, Requirements> {
  const { packageName } = options;
  const osPlatform = yield* libraryModules.OSPlatform;
  const installedPackage = yield* libraryModules.InstalledPackage;
  const maybeRegistration = yield* (yield* libraryModules.Daemon).currentRegistration();
  const commandPath = options.commandPath ?? (yield* osPlatform.getExecutablePath());

  // A service manager starts a daemon with a bare PATH; the one recorded when it was registered is the shell's.
  const searchPath = Option.isSome(maybeRegistration)
    ? maybeRegistration.value.searchPath
    : yield* Effect.sync(() => process.env["PATH"] ?? "");
  const maybeInstall = yield* installedPackage.detect({ packageName, commandPath, searchPath });
  if (Option.isNone(maybeInstall)) {
    yield* Effect.log(`Not upgrading ${packageName} automatically: ${commandPath} is not inside an install of it`);
    return;
  }
  const install = maybeInstall.value;
  const maybePlatform = yield* installedPackage.platform({ packageName, install });
  if (Option.isNone(maybePlatform)) {
    yield* Effect.log(`Not upgrading ${packageName} automatically: none of its platform packages is installed with ${install.packageDir}`);
    return;
  }
  const running = yield* installedPackage.version(install);
  const run = installRun((yield* osPlatform.getCurrentPlatform()).os, maybeRegistration);

  yield* Effect.log(
    `Keeping ${packageName} ${running} up to date: checking every ${CHECK_INTERVAL} with ${install.packageManager} in ${install.cwd}`,
  );
  const progress: Progress = { lastReport: "", installedWithoutRestart: Option.none() };
  const target = { packageName, install, running, platform: maybePlatform.value, run };
  yield* Effect.forever(Effect.gen(function* () {
    yield* effunct(checkOnce)(target, progress);
    yield* Effect.sleep(CHECK_INTERVAL);
  }));
}

function* checkOnce(
  target: {
    readonly packageName: string;
    readonly install: Install;
    readonly running: string;
    readonly platform: string;
    readonly run: InstallRun;
  },
  progress: Progress,
): EffectGen<void, never, Requirements> {
  const { packageName, install, running, platform, run } = target;
  const installedPackage = yield* libraryModules.InstalledPackage;
  const report = (message: string) => Effect.gen(function* () {
    if (message !== progress.lastReport) yield* Effect.log(message);
    progress.lastReport = message;
  });

  const tags = yield* Effect.result(effunct(installedPackage.distTags.bind(installedPackage))({ packageName, install }));
  if (Result.isFailure(tags)) return yield* report(`Could not check for a newer ${packageName}: ${tags.failure}`);
  const latest = tags.success["latest"];
  if (latest === undefined) return yield* report(`Could not check for a newer ${packageName}: it has no latest dist-tag`);
  if (Bun.semver.order(latest, running) <= 0) {
    progress.lastReport = "";
    return;
  }
  if (Option.contains(progress.installedWithoutRestart, latest)) return;

  const platformTag = platformDistTag(LATEST_ENVIRONMENT, "", platform);
  const platformBuild = platformVersion(latest, LATEST_ENVIRONMENT, "", platform);
  if (tags.success[platformTag] !== platformBuild) {
    return yield* report(`${packageName} ${latest} is published but its ${platform} build is not yet (${platformTag} is ${tags.success[platformTag] ?? "unset"}); waiting for it`);
  }

  yield* Effect.log(`Upgrading ${packageName} from ${running} to ${latest} with ${install.packageManager}`);
  const installed = yield* Effect.result(effunct(installedPackage.installVersion.bind(installedPackage))({
    packageName, install, version: latest, run,
  }));
  if (Result.isFailure(installed)) {
    progress.lastReport = "";
    return yield* Effect.log(`Upgrading ${packageName} to ${latest} failed: ${installed.failure}; trying again in ${CHECK_INTERVAL}`);
  }
  if (run._tag === "AfterExit") {
    yield* Effect.log(`Exiting so ${packageName} ${latest} can replace this executable`);
    return yield* Effect.sync(() => process.exit(0));
  }
  // Reached only when installing did not restart this process, which re-registering the daemon does.
  progress.installedWithoutRestart = Option.some(latest);
  yield* Effect.log(`Installed ${packageName} ${latest}, but this process was not restarted; it runs ${running} until it is`);
}

/** How the install escapes this process being stopped by it, decided by what started this process. */
function installRun(os: string, maybeRegistration: Option.Option<DaemonRegistration>): InstallRun {
  if (os === "win32") {
    return InstallRun.AfterExit({
      afterFailure: pipe(
        maybeRegistration,
        Option.filter((registration) => registration.kind === "scheduled-task"),
        Option.map((registration) => ["schtasks", "/Run", "/TN", registration.unit]),
      ),
    });
  }
  return InstallRun.Detached({
    systemdUnit: Option.exists(maybeRegistration, (registration) => registration.kind === "systemd"),
  });
}
