import { Effect, FileSystem, pipe } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { isEnvironment, LOCAL_ENVIRONMENT } from "../../public/manifest";
import { INSTALL_SCRIPT, LOCAL_ALIAS_SUFFIX, OUTDIR, REPAIR_ONLY_FLAG } from "../../common/constants";
import { libraryModules } from "../index";
import { BASE_PACKAGE_DIR, PLATFORMS } from "../builder/interface";
import type { DeployInput, IDeployer } from "./interface";
import { baseDistTag, baseVersion, baseVersionOf, platformDistTag, platformVersion } from "./versions";

interface PlatformPackage {
  readonly platform: string;
  readonly packageDir: string;
  readonly version: string;
  readonly distTag: string;
}

export class DeployerImpl extends implementing(libraryModules.Deployer)
  .uses(libraryModules.OSPlatform, libraryModules.Npm, FileSystem.FileSystem)
  implements IDeployer {

  *deploy({ environment, sourceCommitSha }: DeployInput): EffectGen<void, string> {
    const outDir = resolve(yield* this.dependencies.OSPlatform.getCurrentDirectory(), OUTDIR);
    const { name, version } = yield* this.readBuiltBase(outDir);
    const local = isEnvironment(environment, LOCAL_ENVIRONMENT);

    const platformPackages: PlatformPackage[] = [];
    for (const platform of yield* this.builtPlatforms(outDir)) {
      const stamped = platformVersion(version, environment, sourceCommitSha, platform);
      // `name` is reset because the build's local install renames this folder to `<name>-<platform>`,
      // and the same dist/ is then published by CI: without the reset, the runner's own platform
      // published as a separate package (`<name>-linux-x64`) instead of a version of `<name>`.
      yield* this.updateManifest(resolve(outDir, platform), { name, version: stamped });
      platformPackages.push({
        platform,
        packageDir: resolve(outDir, platform),
        version: stamped,
        distTag: platformDistTag(environment, sourceCommitSha, platform),
      });
    }

    // Everything this run resolved, stated before any of it is acted on: the lines below arrive in
    // completion order, so the plan has to be readable on its own.
    const stampedBase = baseVersion(version, environment, sourceCommitSha);
    const baseTag = baseDistTag(environment, sourceCommitSha);
    yield* Effect.log(`${local ? "Installing" : "Publishing"} ${name}`);
    yield* Effect.log(`Commit ${sourceCommitSha.slice(0, 8) || "unknown"}, built from version ${version} in ${OUTDIR}`);
    yield* Effect.log(local ? "Packages (local-only, no tags):" : "Packages:");
    yield* Effect.log(`  - ${BASE_PACKAGE_DIR}: ${stampedBase}${local ? "" : ` (tag ${baseTag})`}`);
    for (const platformPackage of local ? yield* this.localOnly(platformPackages) : platformPackages) {
      yield* Effect.log(`  - ${platformPackage.platform}: ${platformPackage.version}${local ? "" : ` (tag ${platformPackage.distTag})`}`);
    }

    yield* Effect.log(`Installing npm ${yield* this.dependencies.Npm.ensureAvailable()}`);

    if (local) {
      yield* this.installLocally({ outDir, name, stampedBase, platformPackages });
      return;
    }
    yield* this.publishRelease({ outDir, name, stampedBase, baseTag, platformPackages });
  }

  /**
   * A release publishes the platform packages together first: the base package's optional
   * dependencies name their exact versions, so none of them may be missing once the base is
   * installable. Packing has no such ordering, so all of it happens at once.
   */
  private *publishRelease(input: {
    outDir: string; name: string; stampedBase: string; baseTag: string;
    platformPackages: ReadonlyArray<PlatformPackage>;
  }): EffectGen<void, string> {
    const { outDir, name, stampedBase, baseTag, platformPackages } = input;

    const baseDir = resolve(outDir, BASE_PACKAGE_DIR);
    yield* this.updateManifest(baseDir, {
      version: stampedBase,
      ...(platformPackages.length > 0
        ? {
          optionalDependencies: Object.fromEntries(platformPackages.map((platformPackage) => [
            `${name}-${platformPackage.platform}`,
            `npm:${name}@${platformPackage.version}`,
          ])),
        }
        : {}),
    });

    const toPack = [
      { label: BASE_PACKAGE_DIR, packageDir: baseDir, distTag: baseTag },
      ...platformPackages.map((p) => ({ label: p.platform, packageDir: p.packageDir, distTag: p.distTag })),
    ];
    yield* Effect.log(`Packing ${toPack.length} packages in parallel`);
    const tarballs = yield* Effect.all(
      toPack.map((target) => effunct(this.packOne.bind(this))(outDir, target.label, target.packageDir)),
      { concurrency: toPack.length },
    );
    const tarballOf = new Map(toPack.map((target, index) => [target.label, tarballs[index] as string]));

    // A base version already on the registry means this version was released: the author must bump it,
    // and publishing nothing while reporting success would hide that.
    if (yield* this.dependencies.Npm.versionExists(name, stampedBase)) {
      return yield* Effect.fail(`${name}@${stampedBase} is already published; bump the version to release again`);
    }
    // Platforms already on the registry are a release that failed part-way — an npm 503 after some
    // uploads, say. They are skipped, so running the pipeline again finishes the release instead of
    // failing on a version npm will never accept twice.
    const pending: PlatformPackage[] = [];
    for (const platformPackage of input.platformPackages) {
      if (yield* this.dependencies.Npm.versionExists(name, platformPackage.version)) {
        yield* Effect.log(`  - ${platformPackage.platform} ${platformPackage.version} is already published, skipping`);
      } else {
        pending.push(platformPackage);
      }
    }

    // Platform packages publish under the base package's own name, told apart by version. The first
    // publish of a new name is a create, and the registry refuses concurrent creates of one name
    // (403 "too similar to existing package", 409 "Failed to save packument"). So when the package does
    // not exist yet, one platform goes first and alone; once the registry shows it, the rest go in parallel.
    if (pending.length > 0) {
      const [first, ...rest] = pending;
      let parallel = pending;
      const exists = yield* this.dependencies.Npm.packageExists(name);
      yield* Effect.log(exists
        ? `${name} exists on the registry, so every platform publishes in parallel`
        : `${name} does not exist on the registry yet, so ${first?.platform} publishes alone first to create it`);
      if (first !== undefined && !exists) {
        yield* this.publishOne(first.platform, tarballOf.get(first.platform) as string, first.distTag);
        yield* this.waitUntilVisible(name);
        parallel = rest;
      }
      yield* Effect.log(`Publishing ${parallel.length} platform packages in parallel`);
      yield* Effect.all(
        parallel.map((p) => effunct(this.publishOne.bind(this))(p.platform, tarballOf.get(p.platform) as string, p.distTag)),
        { concurrency: parallel.length || 1 },
      );
    }

    yield* Effect.log("Publishing base package");
    yield* this.publishOne(BASE_PACKAGE_DIR, tarballOf.get(BASE_PACKAGE_DIR) as string, baseTag);
    yield* Effect.log(`Published ${toPack.length} packages`);
  }

  /** Polls until the registry reports the package, so the parallel publishes that follow are updates. */
  private *waitUntilVisible(name: string): EffectGen<void, string> {
    for (let attempt = 1; attempt <= 20; attempt++) {
      if (yield* this.dependencies.Npm.packageExists(name)) {
        yield* Effect.log(`Registry shows ${name} (check ${attempt})`);
        return;
      }
      yield* Effect.log(`Registry does not show ${name} yet (check ${attempt} of 20), retrying in 3 seconds`);
      yield* Effect.sleep("3 seconds");
    }
    return yield* Effect.fail(`${name} was published but the registry still does not show it after 60 seconds`);
  }

  private *packOne(outDir: string, label: string, packageDir: string): EffectGen<string, string> {
    const tarballPath = yield* this.dependencies.Npm.pack(packageDir, outDir);
    yield* Effect.log(`  - ${label} packed`);
    return tarballPath;
  }

  private *publishOne(label: string, tarballPath: string, distTag: string): EffectGen<void, string> {
    yield* this.dependencies.Npm.publish({ tarballPath, tag: distTag });
    yield* Effect.log(`  - ${label} published`);
  }

  /**
   * The local environment installs instead of publishing, and only this machine's platform package
   * is worth packing. Its tarball path goes into the base manifest, so it must exist before the base
   * package is stamped — which is why these two pack in sequence.
   */
  private *installLocally(input: {
    outDir: string; name: string; stampedBase: string; platformPackages: ReadonlyArray<PlatformPackage>;
  }): EffectGen<void, string> {
    const { outDir, name, stampedBase, platformPackages } = input;
    const local = yield* this.localOnly(platformPackages);

    // The platform package is referenced as a folder, not a tarball: the base tarball is deleted once this
    // install finishes, and a tarball reference would leave anything that later installs this package
    // resolving a file that is gone.
    //
    // It also has to be *renamed* first. A published platform package keeps the base package's name and is
    // told apart by its version, with the base aliasing it (`npm:<name>@<version>`) — but `file:` has no
    // alias form, so a folder still calling itself `<name>` is installed under a key nothing can resolve.
    // The launcher then fails with "Could not resolve optional platform package <name>-<platform>", which
    // is true: no package of that name existed. Only the local path renames; publishing must not.
    for (const platformPackage of local) {
      yield* this.updateManifest(platformPackage.packageDir, {
        name: `${name}-${platformPackage.platform}`,
      });
    }

    const optionalDependencies = Object.fromEntries(local.map((platformPackage) => [
      `${name}-${platformPackage.platform}`,
      `file:${platformPackage.packageDir}`,
    ]));

    yield* Effect.log("Packing 1 package");

    const baseDir = resolve(outDir, BASE_PACKAGE_DIR);
    yield* this.updateManifest(baseDir, {
      version: stampedBase,
      ...(local.length > 0 ? { optionalDependencies } : {}),
    });
    const baseTarball = yield* this.packOne(outDir, BASE_PACKAGE_DIR, baseDir);

    const alias = `${name}${LOCAL_ALIAS_SUFFIX}`;
    yield* this.dependencies.Npm.installTarball({ alias, tarballPath: baseTarball });
    yield* Effect.log(`Installed ${alias}@${stampedBase} locally`);

    // The platform package has to be installed here too, not only referenced by the base manifest.
    //
    // A base package installed from a folder — globally, or as a `file:` dependency — is a symlink into
    // this checkout, and module resolution starts from the real path. So the launcher looks for its
    // platform package in *this* package's node_modules and never in the tree it was installed into.
    // Without this, a local install produces commands that resolve nothing.
    for (const platformPackage of local) {
      yield* this.dependencies.Npm.installTarball({
        alias: `${name}-${platformPackage.platform}`,
        tarballPath: platformPackage.packageDir,
      });
      yield* Effect.log(`Installed ${name}-${platformPackage.platform} locally`);
    }

    yield* this.runInstallScript(alias);

    yield* pipe(
      this.getDependency(FileSystem.FileSystem).remove(baseTarball, { force: true }),
      Effect.mapError((e) => `Cannot remove ${baseTarball}: ${e.message}`),
    );
  }

  /**
   * Runs the installed package's own install script, which npm would have run as a postinstall hook.
   *
   * Bun, which is what performs the install here, refuses lifecycle scripts for any package not named in
   * `trustedDependencies` — reasonably, since a postinstall hook is arbitrary code. That leaves the local
   * install with launchers that have not been linked to a binary and daemons that have not been
   * registered, which is the whole point of installing locally. This package's own installer is not
   * untrusted code, so run it directly.
   *
   * Repair only. This install exists so the launcher can resolve its platform package from the building
   * package's own tree — it is not a copy anyone chose to install, and treating it as one registered a
   * second daemon for every package that has any: one here, one from wherever the build output was
   * actually installed. Repair-only also deregisters, so a copy registered under the old behaviour is
   * cleaned up by the next build.
   */
  private *runInstallScript(alias: string): EffectGen<void, string> {
    const rootDir = yield* this.dependencies.OSPlatform.getCurrentDirectory();
    const scriptPath = resolve(rootDir, "node_modules", alias, INSTALL_SCRIPT);
    if (!(yield* pipe(
      this.getDependency(FileSystem.FileSystem).exists(scriptPath),
      Effect.mapError((e) => e.message),
    ))) return;

    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "node",
      args: [scriptPath, REPAIR_ONLY_FLAG],
      cwd: rootDir,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`${INSTALL_SCRIPT} failed with exit code ${result.exitCode}`);
    }
  }

  /** The one platform package this machine can actually install, if the build produced it. */
  private *localOnly(
    platformPackages: ReadonlyArray<PlatformPackage>,
  ): EffectGen<ReadonlyArray<PlatformPackage>, string> {
    if (platformPackages.length === 0) return [];
    const { os, cpu } = yield* this.dependencies.OSPlatform.getCurrentPlatform();
    const platform = PLATFORMS.find((candidate) => candidate.os === os && candidate.cpu === cpu);
    const built = platform && platformPackages.find((candidate) => candidate.platform === platform.id);
    if (!built) {
      return yield* Effect.fail(`No platform package was built for this machine (${os}-${cpu}) — nothing to install`);
    }
    return [built];
  }

  /** Recovers the name and clean X.Y.Z the build stamped, failing loudly if dist/ is not a build. */
  private *readBuiltBase(outDir: string): EffectGen<{ name: string; version: string }, string> {
    const manifest = yield* this.readManifest(resolve(outDir, BASE_PACKAGE_DIR));
    const name = manifest["name"];
    const stamped = manifest["version"];
    if (typeof name !== "string" || typeof stamped !== "string") {
      return yield* Effect.fail(`${OUTDIR}/${BASE_PACKAGE_DIR}/package.json has no name or version — run the build first`);
    }
    const version = baseVersionOf(stamped);
    if (version === undefined) {
      return yield* Effect.fail(`${OUTDIR}/${BASE_PACKAGE_DIR}/package.json version "${stamped}" is not a local build — run the build first`);
    }
    return { name, version };
  }

  private *builtPlatforms(outDir: string): EffectGen<ReadonlyArray<string>, string> {
    const children = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readDirectory(outDir),
      Effect.mapError((e) => `Cannot read ${OUTDIR}: ${e.message}`),
    );
    const known = new Set<string>(PLATFORMS.map((platform) => platform.id));
    return children.filter((child) => known.has(child)).sort();
  }

  private *readManifest(packageDir: string): EffectGen<Record<string, unknown>, string> {
    const text = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readFileString(resolve(packageDir, "package.json")),
      Effect.mapError((e) => `Cannot read ${packageDir}/package.json: ${e.message}`),
    );
    return yield* Effect.try({
      try: () => JSON.parse(text) as Record<string, unknown>,
      catch: (e) => `${packageDir}/package.json is not valid JSON: ${(e as Error).message}`,
    });
  }

  private *updateManifest(packageDir: string, fields: Record<string, unknown>): EffectGen<void, string> {
    const manifest = yield* this.readManifest(packageDir);
    yield* pipe(
      this.getDependency(FileSystem.FileSystem).writeFileString(
        resolve(packageDir, "package.json"),
        `${JSON.stringify({ ...manifest, ...fields }, null, 2)}\n`,
      ),
      Effect.mapError((e) => `Cannot write ${packageDir}/package.json: ${e.message}`),
    );
  }
}
