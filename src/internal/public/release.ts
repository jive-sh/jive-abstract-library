import { Effect, FileSystem, Layer, Option, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { effunct } from "effective-modules";
import type { DeployPlan } from "./deploy-plan";
import type { ProvisionWithJive } from "./manifest";
import { resolve } from "node:path";
import { libraryModules } from "../modules";
import { JiveServerImpl } from "../modules/jive-server/impl";
import { NpmImpl } from "../modules/npm/impl";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import { PipelineIdentityImpl } from "../modules/pipeline-identity/impl";
import { baseDistTag, baseVersion } from "../modules/deployer/versions";

/**
 * Packaging and publishing for any package built by a Jive template, not just this one. A template
 * whose build produces its own package — a generated API client, say — uses these rather than
 * restating the version rules and the npm invocations.
 */

const layer = pipe(
  JiveServerImpl.Layer,
  Layer.provideMerge(PipelineIdentityImpl.Layer),
  Layer.provideMerge(NpmImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
  Layer.provideMerge(FetchHttpClient.layer),
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
  /**
   * The Jive server to provision the package with right before it is published, as a package's
   * `jive.library.provisionWithJive` gives it, or none to publish without asking Jive. Required, so each
   * abstract publishing through this function decides it.
   */
  readonly provisionWithJive: Option.Option<ProvisionWithJive>;
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

/**
 * The `deploy-plan` hook's answer for a package whose deploy publishes `<name>@<version>` to npm: nothing to
 * deploy when `registry` (the package's `publishConfig.registry`; none means npm's configured registry) already
 * lists that version, else a deploy to the version's npm page. The same check this abstract's own plan makes.
 */
export function planNpmRelease(input: { readonly name: string; readonly version: string; readonly registry: Option.Option<string> }): Effect.Effect<DeployPlan, string> {
  return pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.Npm).planRelease(input);
    })(),
    Effect.provide(layer),
  );
}

/**
 * Stamps the package's version into its manifest, packs it, asks Jive to provision it when the target says
 * so, and publishes it under its dist-tag. A refusal from Jive fails before anything is published.
 */
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

      const name = manifest["name"];
      if (typeof name !== "string") {
        return yield* Effect.fail(`${manifestPath} has no name`);
      }

      if (Option.isSome(target.provisionWithJive)) {
        yield* (yield* libraryModules.JiveServer).provisionPackage({
          serverUrl: target.provisionWithJive.value.serverUrl,
          registry: "npm",
          packageName: name,
        });
      }
      yield* Effect.log(`Packing ${target.version}`);
      const tarballPath = yield* npm.pack(target.packageDir, target.outDir);
      yield* Effect.log(`Publishing ${target.version} under ${target.distTag}`);
      yield* npm.publish({ tarballPath, tag: target.distTag });
      yield* Effect.log(`Published ${target.version}`);
    })(),
    Effect.provide(layer),
  );
}
