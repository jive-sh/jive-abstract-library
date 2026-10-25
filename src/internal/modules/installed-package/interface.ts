import { Data, type Option } from "effect";
import type { EffectGen } from "effective-modules";

export type PackageManagerName = "bun" | "pnpm" | "npm" | "yarn";

/** How a package was installed on this machine, and so how its package manager is run again for it. */
export interface Install {
  readonly packageManager: PackageManagerName;
  readonly scope: "global" | "local";
  /**
   * Where the package manager runs: the project, for a local install, and for a global one the directory
   * holding the global `node_modules`. The manager's configuration there (`.npmrc`, `bunfig.toml`) is what
   * the install used, so a custom registry applies without this library knowing about it.
   */
  readonly cwd: string;
  /** The installed package's real directory. */
  readonly packageDir: string;
  /**
   * The environment the manager runs with: this process's, with `PATH` replaced by the search path the
   * caller supplied, plus `BUN_INSTALL` or `PNPM_HOME` for a global bun or pnpm install, read from where
   * the package is. A daemon has neither from its service manager, and without them bun installs into the
   * default location and pnpm refuses a global install.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where `installVersion` runs the install, which decides what it can survive. */
export type InstallRun = Data.TaggedEnum<{
  /** A child of this process, with its output, failing when a step fails. */
  Attached: {};
  /**
   * In a process of its own that survives this one being stopped: its own session on macOS and Linux, and a
   * transient systemd user unit when this process runs in one, whose stop kills its whole cgroup. Waits for
   * it, so a failure is still reported if this process outlives it.
   */
  Detached: { readonly systemdUnit: boolean };
  /**
   * Windows, where a running executable cannot be replaced: a helper waits for this process to exit, then
   * installs. `afterFailure` runs if the install fails, to bring back what this process's exit stopped.
   */
  AfterExit: { readonly afterFailure: Option.Option<ReadonlyArray<string>> };
}>;
export const InstallRun = Data.taggedEnum<InstallRun>();

export interface IInstalledPackage {
  /**
   * How the command at `commandPath` was installed: globally or into a project, by bun, pnpm, yarn or npm.
   * None when it is not inside an install, such as a build run from a checkout. `searchPath` is the `PATH`
   * the package manager is looked up on.
   */
  detect(input: { readonly packageName: string; readonly commandPath: string; readonly searchPath: string }): EffectGen<Option.Option<Install>>;
  /** The version the installed package's manifest names. */
  version(install: Install): EffectGen<string, string>;
  /**
   * The platform id (`darwin-arm64`, …) of the platform package installed beside the package, which holds
   * its commands' binary. None when it has none.
   */
  platform(input: { readonly packageName: string; readonly install: Install }): EffectGen<Option.Option<string>>;
  /** The package's dist-tags as the manager that installed it reports them, from the registry it is configured for. */
  distTags(input: { readonly packageName: string; readonly install: Install }): EffectGen<Readonly<Record<string, string>>, string>;
  /**
   * Installs `<packageName>@<version>` the way it was installed, then runs the new version's `install.cjs`
   * where the manager skips install scripts (bun and pnpm do, for packages not on their allowlist). Skipped,
   * the commands stay JS launchers until first run, and a registered daemon, started without `node` on its
   * PATH, fails at its next start and is never re-registered for the new version.
   */
  installVersion(input: {
    readonly packageName: string;
    readonly install: Install;
    readonly version: string;
    readonly run: InstallRun;
  }): EffectGen<void, string>;
}
