import type { EffectGen } from "effective-modules";

export interface PublishInput {
  readonly tarballPath: string;
  /** npm dist-tag the package is published under. */
  readonly tag: string;
}

export interface InstallTarballInput {
  /** Name the tarball is installed under, so it can sit alongside the package it was built from. */
  readonly alias: string;
  readonly tarballPath: string;
}

export interface INpm {
  /**
   * Resolves the pinned npm release and reports its version. Called once before any parallel work:
   * several concurrent resolutions of the same package race, and one of them loses.
   */
  ensureAvailable(): EffectGen<string, string>;
  /** Packs a package directory into a tarball in outDir, returning its absolute path. */
  pack(packageDir: string, outDir: string): EffectGen<string, string>;
  publish(input: PublishInput): EffectGen<void, string>;
  /** Whether the registry has any version of this package. Fails on anything but found or 404. */
  packageExists(name: string): EffectGen<boolean, string>;
  /** Whether the registry has this exact version. Fails on anything but found or 404. */
  versionExists(name: string, version: string): EffectGen<boolean, string>;
  /**
   * Installs a built tarball into the current workspace under an alias, without recording it in
   * package.json or the lockfile — a persisted file: dependency would break a fresh CI install,
   * which has no dist/ to resolve.
   */
  installTarball(input: InstallTarballInput): EffectGen<void, string>;
}
