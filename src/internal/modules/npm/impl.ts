import { tmpdir } from "node:os";
import { Effect, FileSystem, Option, Result, Schema, pipe } from "effect";
import { HttpClient } from "effect/http";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { NPM_PACKAGE_SPEC, NPM_WEBSITE_URL } from "../../common/constants";
import type { DeployPlan } from "../../public/deploy-plan";
import { libraryModules } from "../index";
import { Availability, type INpm, type InstallTarballInput, type PublishInput } from "./interface";

const TARBALL_REQUEST_TIMEOUT = "30 seconds";

/** npm asks its configured registry unless told the one a package publishes to. */
const registryArgs = (registry: Option.Option<string>): ReadonlyArray<string> =>
  Option.match(registry, { onNone: () => [], onSome: (url) => ["--registry", url] });

export class NpmImpl extends implementing(libraryModules.Npm)
  .uses(libraryModules.OSPlatform, FileSystem.FileSystem, HttpClient.HttpClient)
  implements INpm {
  *ensureAvailable(): EffectGen<string, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "--version"],
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`Cannot resolve ${NPM_PACKAGE_SPEC}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
    }
    return result.stdout.trim().split("\n").at(-1) ?? NPM_PACKAGE_SPEC;
  }

  *pack(packageDir: string, outDir: string): EffectGen<string, string> {
    // npm keeps a copy of every tarball it packs in its cache, and a pack always starts from freshly
    // stamped files so that copy is never reused. A throwaway cache keeps it out of dist/, which is
    // uploaded as the deploy artifact, and out of the user's own ~/.npm.
    const fs = this.getDependency(FileSystem.FileSystem);
    const cacheDir = yield* pipe(
      fs.makeTempDirectory({ prefix: "jive-npm-cache-" }),
      Effect.mapError((e) => `Cannot create a temporary npm cache: ${e.message}`),
    );

    try {
      const result = yield* this.dependencies.OSPlatform.spawnProcess({
        command: "bunx",
        args: [
          NPM_PACKAGE_SPEC, "pack", packageDir,
          "--pack-destination", outDir,
          "--ignore-scripts",
          "--cache", cacheDir,
          "--loglevel", "error",
        ],
      });
      if (result.exitCode !== 0) {
        return yield* Effect.fail(`npm pack failed for ${packageDir}:\n${result.stderr.trim()}`);
      }

      const fileName = result.stdout.trim().split("\n").at(-1);
      if (!fileName) {
        return yield* Effect.fail(`npm pack did not report an output file for ${packageDir}`);
      }
      return resolve(outDir, fileName);
    } finally {
      yield* pipe(fs.remove(cacheDir, { recursive: true, force: true }), Effect.ignore);
    }
  }

  /**
   * Publishes one tarball, authenticating from `NPM_TOKEN` when the environment supplies it.
   *
   * Nothing else writes npm credentials: a runner has no `~/.npmrc`, so without this every publish in
   * CI failed with `ENEEDAUTH` no matter which secret was set. The token goes into a temporary config
   * file passed with `--userconfig` rather than onto the command line, where it would be visible to
   * `ps` and echoed by any shell error. The file is removed whether or not the publish succeeds.
   */
  *publish({ tarballPath, tag }: PublishInput): EffectGen<void, string> {
    const token = yield* Effect.sync(() => process.env["NPM_TOKEN"]);
    const configPath = token ? yield* this.writeNpmrc(token) : undefined;

    try {
      const result = yield* this.dependencies.OSPlatform.spawnProcess({
        command: "bunx",
        args: [
          // Scoped packages default to private, which needs a paid plan: without this every publish
          // under a scope fails with 402 Payment Required.
          NPM_PACKAGE_SPEC, "publish", tarballPath, "--tag", tag, "--access", "public",
          ...(configPath === undefined ? [] : ["--userconfig", configPath]),
        ],
        stdout: "inherit",
        stderr: "inherit",
      });
      if (result.exitCode !== 0) {
        return yield* Effect.fail(`npm publish failed for ${tarballPath} with exit code ${result.exitCode}`);
      }
    } finally {
      if (configPath !== undefined) {
        yield* Effect.ignore(this.getDependency(FileSystem.FileSystem).remove(configPath, { force: true }));
      }
    }
  }

  *availability(input: { readonly spec: string; readonly registry: Option.Option<string> }): EffectGen<Availability> {
    const { spec, registry } = input;
    const osPlatform = this.dependencies.OSPlatform;
    const view = yield* Effect.result(effunct(osPlatform.spawnProcess.bind(osPlatform))({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "view", spec, "dist.tarball", "--json", ...registryArgs(registry)],
    }));
    if (Result.isFailure(view)) return Availability.NotYet({ reason: view.failure });
    const output = [view.success.stdout, view.success.stderr].join(" ").trim().replace(/\s+/g, " ");
    if (view.success.exitCode !== 0) {
      return Availability.NotYet({
        reason: /\bE404\b/.test(output) ? "the registry does not list it yet" : `npm view exited with code ${view.success.exitCode}: ${output}`,
      });
    }
    const tarballUrl = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NonEmptyString))(view.success.stdout.trim());
    if (Option.isNone(tarballUrl)) return Availability.NotYet({ reason: `npm view printed no tarball URL: ${output}` });

    const response = yield* Effect.result(pipe(
      this.getDependency(HttpClient.HttpClient).head(tarballUrl.value),
      Effect.timeout(TARBALL_REQUEST_TIMEOUT),
    ));
    if (Result.isFailure(response)) return Availability.NotYet({ reason: `requesting ${tarballUrl.value} failed: ${String(response.failure)}` });
    if (response.success.status < 200 || response.success.status >= 300) {
      return Availability.NotYet({ reason: `the registry lists it, but ${tarballUrl.value} answers ${response.success.status}` });
    }
    return Availability.Downloadable({ tarballUrl: tarballUrl.value });
  }

  *versionExists(input: { readonly spec: string; readonly registry: Option.Option<string> }): EffectGen<boolean, string> {
    const { spec, registry } = input;
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "view", spec, "version", "--json", ...registryArgs(registry)],
    });
    const output = [result.stdout, result.stderr].join("\n").trim();
    if (result.exitCode !== 0) {
      if (/\bE404\b/.test(output)) return false;
      return yield* Effect.fail(`npm view failed for ${spec}:\n${output}`);
    }
    const version = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.NonEmptyString))(result.stdout.trim());
    if (Option.isNone(version)) return yield* Effect.fail(`npm view printed no version for ${spec}:\n${output}`);
    return true;
  }

  *planRelease(input: { readonly name: string; readonly version: string; readonly registry: Option.Option<string> }): EffectGen<DeployPlan, string> {
    const { name, version, registry } = input;
    const registryName = Option.getOrElse(registry, () => "npm's registry");
    if (yield* this.versionExists({ spec: `${name}@${version}`, registry })) {
      yield* Effect.log(`${name}@${version} is already on ${registryName}, so there is nothing to publish`);
      return { deploy: false };
    }
    yield* Effect.log(`${name}@${version} is not on ${registryName} yet, so it is published`);
    return { deploy: true, url: `${NPM_WEBSITE_URL}/package/${name}/v/${version}` };
  }

  *packageExists(name: string): EffectGen<boolean, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "view", name, "name", "--json"],
    });
    if (result.exitCode === 0) return true;
    if (/\bE404\b/.test(result.stderr) || /\bE404\b/.test(result.stdout)) return false;
    return yield* Effect.fail(`npm view failed for ${name}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
  }

  private *writeNpmrc(token: string): EffectGen<string, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const path = resolve(tmpdir(), `jive-npmrc-${process.pid}-${Date.now()}`);
    yield* pipe(
      fs.writeFileString(path, `//registry.npmjs.org/:_authToken=${token}\n`, { mode: 0o600 }),
      Effect.mapError((e) => `Cannot write ${path}: ${e.message}`),
    );
    return path;
  }

  *installTarball({ alias, tarballPath }: InstallTarballInput): EffectGen<void, string> {
    // Captured rather than inherited: a hook whose stdout the pipeline parses must stay clean, and
    // `bun add` writes its progress there.
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bun",
      args: ["add", "--no-save", `${alias}@${tarballPath}`],
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`bun add failed for ${alias}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
    }
  }
}
