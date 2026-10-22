import { tmpdir } from "node:os";
import { Effect, FileSystem, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { NPM_PACKAGE_SPEC } from "../../common/constants";
import { libraryModules } from "../index";
import type { INpm, InstallTarballInput, PublishInput } from "./interface";

export class NpmImpl extends implementing(libraryModules.Npm).uses(libraryModules.OSPlatform, FileSystem.FileSystem) implements INpm {
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

  *packageExists(name: string): EffectGen<boolean, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "view", name, "name", "--json"],
    });
    if (result.exitCode === 0) return true;
    if (/\bE404\b/.test(result.stderr) || /\bE404\b/.test(result.stdout)) return false;
    return yield* Effect.fail(`npm view failed for ${name}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
  }

  *versionExists(name: string, version: string): EffectGen<boolean, string> {
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bunx",
      args: [NPM_PACKAGE_SPEC, "view", `${name}@${version}`, "version", "--json"],
    });
    if (result.exitCode === 0) return result.stdout.includes(JSON.stringify(version));
    if (/\bE404\b/.test(result.stderr) || /\bE404\b/.test(result.stdout)) return false;
    return yield* Effect.fail(`npm view failed for ${name}@${version}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
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
