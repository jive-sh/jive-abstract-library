import { Data, type Option } from "effect";
import type { EffectGen } from "effective-modules";
import type { DeployPlan } from "../../public/deploy-plan";

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

/** Whether a published version can be installed yet. */
export type Availability = Data.TaggedEnum<{
  Downloadable: { readonly tarballUrl: string };
  /** `reason` says which check failed: the registry not listing the version, or its tarball not downloading. */
  NotYet: { readonly reason: string };
}>;
export const Availability = Data.taggedEnum<Availability>();

export interface INpm {
  /**
   * Resolves the pinned npm release and reports its version. Called once before any parallel work:
   * several concurrent resolutions of the same package race, and one of them loses.
   */
  ensureAvailable(): EffectGen<string, string>;
  /** Packs a package directory into a tarball in outDir, returning its absolute path. */
  pack(packageDir: string, outDir: string): EffectGen<string, string>;
  publish(input: PublishInput): EffectGen<void, string>;
  /**
   * Whether `spec` (`<name>@<version>`) can be installed from `registry` yet: the registry lists the version
   * and its tarball downloads. npm accepts a publish minutes before it does both. `registry` is the one the
   * package publishes to; none means npm's configured registry. Every failure is reported as not yet, with
   * its reason, since the caller retries.
   */
  availability(input: { readonly spec: string; readonly registry: Option.Option<string> }): EffectGen<Availability>;
  /**
   * Whether `registry` lists `spec` (`<name>@<version>`): the registry the package publishes to, or npm's
   * configured one when none is given. A missing package and a missing version are both false; anything but
   * found or 404 fails, since a wrong answer either republishes a version or skips a release.
   */
  versionExists(input: { readonly spec: string; readonly registry: Option.Option<string> }): EffectGen<boolean, string>;
  /**
   * What publishing `<name>@<version>` to `registry` would do: nothing when the registry already lists that
   * version, since npm refuses to publish over it; otherwise a deploy whose URL is the version's npm page.
   * Every package whose deploy publishes to npm plans with this, so a push without a version bump is skipped.
   */
  planRelease(input: { readonly name: string; readonly version: string; readonly registry: Option.Option<string> }): EffectGen<DeployPlan, string>;
  /** Whether the registry has any version of this package. Fails on anything but found or 404. */
  packageExists(name: string): EffectGen<boolean, string>;
  /**
   * Installs a built tarball into the current workspace under an alias, without recording it in
   * package.json or the lockfile — a persisted file: dependency would break a fresh CI install,
   * which has no dist/ to resolve.
   */
  installTarball(input: InstallTarballInput): EffectGen<void, string>;
}
