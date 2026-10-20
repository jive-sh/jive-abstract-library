import { Effect, FileSystem, Layer, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct } from "effective-modules";
import { resolve } from "node:path";
import { libraryModules } from "../modules";
import { NpmImpl } from "../modules/npm/impl";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import { baseDistTag, baseVersion } from "../modules/deployer/versions";

/**
 * Packaging and publishing for any package built by a Jive template, not just this one. A template
 * whose build produces its own package — a generated API client, say — uses these rather than
 * restating the version rules and the npm invocations.
 */

const layer = pipe(
  NpmImpl.Layer,
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
) satisfies Layer.Layer<any, any, never>;

export interface ReleaseTarget {
  /** Directory holding the package to publish, containing its package.json. */
  readonly packageDir: string;
  /** Directory the tarball is written to before publishing. */
  readonly outDir: string;
  /** The package's released version, usually from {@link releaseVersion}. */
  readonly version: string;
  /** npm dist-tag to publish under, usually from {@link releaseDistTag}. */
  readonly distTag: string;
}

/** The version a package takes for this environment: bare on `latest`, prereleased otherwise. */
export function releaseVersion(version: string, environment: string, sourceCommitSha: string): string {
  return baseVersion(version, environment, sourceCommitSha);
}

/** The npm dist-tag for this environment, which always mirrors the prerelease. */
export function releaseDistTag(environment: string, sourceCommitSha: string): string {
  return baseDistTag(environment, sourceCommitSha);
}

/** Resolves the pinned npm release once, so parallel packs do not race to install it. */
export function ensureNpm(): Effect.Effect<string, string> {
  return pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.Npm).ensureAvailable();
    })(),
    Effect.provide(layer),
  );
}

/** Stamps the package's version into its manifest, packs it, and publishes it under its dist-tag. */
export function publishPackage(target: ReleaseTarget): Effect.Effect<void, string> {
  return pipe(
    effunct(function* () {
      const npm = yield* libraryModules.Npm;
      const fs = yield* FileSystem.FileSystem;
      const manifestPath = resolve(target.packageDir, "package.json");

      const text = yield* pipe(
        fs.readFileString(manifestPath),
        Effect.mapError((e) => `Cannot read ${manifestPath}: ${e.message}`),
      );
      const manifest = yield* Effect.try({
        try: () => JSON.parse(text) as Record<string, unknown>,
        catch: (e) => `${manifestPath} is not valid JSON: ${(e as Error).message}`,
      });
      yield* pipe(
        fs.writeFileString(manifestPath, `${JSON.stringify({ ...manifest, version: target.version }, null, 2)}\n`),
        Effect.mapError((e) => `Cannot write ${manifestPath}: ${e.message}`),
      );

      yield* Effect.log(`Packing ${target.version}`);
      const tarballPath = yield* npm.pack(target.packageDir, target.outDir);
      yield* Effect.log(`Publishing ${target.version} under ${target.distTag}`);
      yield* npm.publish({ tarballPath, tag: target.distTag });
      yield* Effect.log(`Published ${target.version}`);
    })(),
    Effect.provide(layer),
  );
}
