import { Effect, Layer, Logger, Option, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct, type EffectGen } from "effective-modules";
import { stderrLogger } from "../common/logger";
import { libraryModules, type LibraryModules } from "../modules";
import { InstalledPackageImpl } from "../modules/installed-package/impl";
import { InstallRun } from "../modules/installed-package/interface";
import { OSPlatformImpl } from "../modules/os-platform/impl";

/**
 * Upgrades an installed package to its latest version with the package manager that installed it.
 *
 * Every package built from this library can offer an `upgrade` command that is one call to this. Where
 * the running command lives says how it was installed — globally or into a project, by bun, pnpm, yarn
 * or npm — and the same manager then installs `<package>@latest` the same way. `autoUpgrade` does the same
 * on its own, from a daemon.
 */

export interface UpgradeOptions {
  /** The package to upgrade, e.g. `@jive-sh/skill-sync`. */
  readonly packageName: string;
  /** The running command. Defaults to this process's executable, which is right for a compiled command. */
  readonly commandPath?: string;
}

/** Only what upgrading needs, since this is bundled into every command that offers `upgrade`. */
export const installedPackageLayer = pipe(
  InstalledPackageImpl.Layer,
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
) satisfies Layer.Layer<any, any, never>;

export const upgrade = (options: UpgradeOptions): Effect.Effect<void, string> => pipe(
  effunct(upgradeAction)(options),
  Effect.provide(installedPackageLayer),
  Effect.provide(Logger.layer([stderrLogger])),
);

function* upgradeAction(options: UpgradeOptions): EffectGen<void, string, LibraryModules.OSPlatform | LibraryModules.InstalledPackage> {
  const osPlatform = yield* libraryModules.OSPlatform;
  const installedPackage = yield* libraryModules.InstalledPackage;
  const commandPath = options.commandPath ?? (yield* osPlatform.getExecutablePath());
  const maybeInstall = yield* installedPackage.detect({
    packageName: options.packageName,
    commandPath,
    searchPath: yield* Effect.sync(() => process.env["PATH"] ?? ""),
  });
  if (Option.isNone(maybeInstall)) {
    return yield* Effect.fail(
      `could not tell how ${options.packageName} was installed from ${commandPath}; upgrade it with your package manager`,
    );
  }
  const install = maybeInstall.value;
  yield* Effect.log(`${options.packageName} was installed ${install.scope === "global" ? "globally" : "in this project"} with ${install.packageManager}.`);

  // Windows locks a running executable, so replacing the package from inside this process fails with
  // EBUSY. A helper waits for this process to exit and then installs.
  if ((yield* osPlatform.getCurrentPlatform()).os === "win32") {
    yield* installedPackage.installVersion({
      packageName: options.packageName, install, version: "latest", run: InstallRun.AfterExit({ afterFailure: Option.none() }),
    });
    yield* Effect.log("The upgrade continues in a separate window once this command exits.");
    return;
  }
  yield* installedPackage.installVersion({ packageName: options.packageName, install, version: "latest", run: InstallRun.Attached() });
}
