import { Effect, FileSystem, Option, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { basename, dirname, relative, resolve } from "node:path";
import ejs from "ejs";
import type { PackageJson } from "../../public/manifest";
import {
  BIN_DIR,
  DAEMON_HOME_DIR,
  DAEMON_ID_PREFIX,
  DAEMON_LOG_SUBDIR,
  DAEMON_REGISTRY_SUBDIR,
  DAEMON_SOURCE_DIR,
  ENTRYPOINT_SOURCE_DIR,
  INSTALL_SCRIPT,
  LICENSE_FILE,
  MULTI_CALL_BINARY,
  OUTDIR,
  README_FILE,
  REPAIR_ONLY_FLAG,
  WINDOWS_EXECUTABLE_SUFFIX,
  WORKDIR,
} from "../../common/constants";
import { editJsonc, insertAfter } from "../../common/jsonc";
import { COMMAND_LAUNCHER_TEMPLATE } from "../../common/command-launcher";
import { libraryModules } from "../index";
import { BASE_PACKAGE_DIR, PLATFORMS, type BuildInput, type BuildResult, type IBuilder, type Platform } from "./interface";
import { LOCAL_ENVIRONMENT } from "../../public/manifest";

/**
 * Source package layout the builder reads:
 *   src/index.ts        Optional library entrypoint; when present, dist/index.js is emitted and exported.
 *   src/entrypoints/*   Command entrypoints compiled into the multi-call binary.
 *   src/daemons/*      Daemon entrypoints — long-lived background processes — compiled into the same
 *                       binary. Named daemons, not agents: Jive runs AI agents, and a compiled background
 *                       process is not one of those.
 *
 * Only src/index.ts and its emit reach the published package. Everything else — internals,
 * entrypoints, daemons — exists in the compiled binary alone, so there is no private subpath for
 * a consumer to import and no unreachable JS shipped alongside the public entrypoint.
 */

const COMMAND_SOURCE_DIRS = [ENTRYPOINT_SOURCE_DIR, DAEMON_SOURCE_DIR] as const;
const SOURCE_ENTRYPOINT = "src/index.ts";
const EMITTED_ENTRYPOINT = "index.js";
const SOURCE_SUFFIX = ".ts";
const TEST_SUFFIXES = [".test.ts", ".test.js", ".test.js.map"] as const;
const BASE_PACKAGE_ROOT_FILES = [README_FILE, LICENSE_FILE] as const;
const TSCONFIG_INCLUDE = ["src/**/*.ts"];
const TSCONFIG_EXCLUDE = [OUTDIR, "node_modules"];

interface CommandSource {
  readonly command: string;
  readonly sourcePath: string;
}

/** Everything resolved once at the start of a build and shared by every step that follows. */
interface BuildContext {
  readonly rootDir: string;
  readonly outDir: string;
  readonly workDir: string;
  readonly packageJson: PackageJson;
  readonly repositoryUrl: Option.Option<string>;
  readonly commandSources: ReadonlyArray<CommandSource>;
  /** Daemon entries found in src/daemons/, which the manifest must list exactly. */
  readonly daemons: ReadonlyArray<string>;
  readonly rootFiles: ReadonlyArray<string>;
  readonly hasSourceEntrypoint: boolean;
  readonly platforms: ReadonlyArray<Platform>;
  readonly localOnly: boolean;
}

export class BuilderImpl extends implementing(libraryModules.Builder)
  .uses(libraryModules.OSPlatform, libraryModules.Git, libraryModules.Package, libraryModules.Daemon, FileSystem.FileSystem)
  implements IBuilder {

  *build(input: BuildInput): EffectGen<BuildResult, string> {
    const context = yield* this.resolveContext(input);
    const fs = this.getDependency(FileSystem.FileSystem);

    yield* Effect.log(
      `Building ${context.packageJson.name} ${context.packageJson.version} into ${OUTDIR}:`
      + ` ${context.hasSourceEntrypoint ? "library entrypoint" : "no library entrypoint"},`
      + ` ${context.commandSources.length} command(s)`
      + `${context.commandSources.length > 0 ? ` (${context.commandSources.map((c) => c.command).join(", ")})` : ""},`
      + ` ${context.daemons.length} daemon(s)`
      + `${context.daemons.length > 0 ? ` (${context.daemons.join(", ")})` : ""},`
      + ` ${context.platforms.length} platform(s)`,
    );

    yield* this.fsOp(fs.remove(context.outDir, { recursive: true, force: true }));
    yield* this.fsOp(fs.makeDirectory(context.workDir, { recursive: true }));

    try {
      if (context.commandSources.length > 0) {
        yield* this.fsOp(fs.writeFileString(multiCallEntrypointPath(context), generateMultiCallEntrypoint(context)));
      }

      yield* this.buildBasePackage(context);
      for (const platform of context.platforms) {
        yield* this.buildPlatformPackage(context, platform);
      }

      const platforms = context.platforms.map((platform) => platform.id);
      yield* Effect.log(`Built ${BASE_PACKAGE_DIR}${platforms.length > 0 ? ` and ${platforms.join(", ")}` : ""}`);
      return { platforms };
    } finally {
      yield* this.fsOp(fs.remove(context.workDir, { recursive: true, force: true }));
    }
  }

  private *resolveContext(input: BuildInput): EffectGen<BuildContext, string> {
    const rootDir = yield* this.dependencies.OSPlatform.getCurrentDirectory();
    const packageJson = yield* this.dependencies.Package.load();
    const maybeRemote = yield* this.dependencies.Git.getRemoteOrigin();
    const commandSources = yield* this.collectCommandSources(rootDir);
    const daemons = yield* this.resolveDaemons(rootDir, packageJson);
    const outDir = resolve(rootDir, OUTDIR);

    return {
      rootDir,
      daemons,
      outDir,
      workDir: resolve(outDir, WORKDIR),
      packageJson,
      repositoryUrl: Option.map(maybeRemote, (remote) => remote.packageJsonUrl),
      commandSources,
      rootFiles: yield* this.collectRootFiles(rootDir),
      hasSourceEntrypoint: yield* this.exists(resolve(rootDir, SOURCE_ENTRYPOINT)),
      platforms: commandSources.length === 0
        ? []
        : input.localOnly
          ? [yield* this.getLocalPlatform()]
          : PLATFORMS,
      localOnly: input.localOnly,
    };
  }

  private *collectCommandSources(rootDir: string): EffectGen<ReadonlyArray<CommandSource>, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const commands = new Map<string, CommandSource>();

    for (const sourceDir of COMMAND_SOURCE_DIRS) {
      const absoluteDir = resolve(rootDir, sourceDir);
      if (!(yield* this.exists(absoluteDir))) continue;

      const children = yield* this.fsOp(fs.readDirectory(absoluteDir));
      for (const child of [...children].sort()) {
        if (!child.endsWith(SOURCE_SUFFIX)) continue;

        const command = basename(child, SOURCE_SUFFIX);
        const sourcePath = resolve(absoluteDir, child);
        const existing = commands.get(command);
        if (existing) {
          return yield* Effect.fail(`Duplicate command "${command}" in ${existing.sourcePath} and ${sourcePath}`);
        }
        commands.set(command, { command, sourcePath });
      }
    }

    return [...commands.values()].sort((a, b) => a.command.localeCompare(b.command));
  }

  private *collectRootFiles(rootDir: string): EffectGen<ReadonlyArray<string>, string> {
    const present: string[] = [];
    for (const fileName of BASE_PACKAGE_ROOT_FILES) {
      if (yield* this.exists(resolve(rootDir, fileName))) present.push(fileName);
    }
    return present;
  }

  private *getLocalPlatform(): EffectGen<Platform, string> {
    const { os, cpu } = yield* this.dependencies.OSPlatform.getCurrentPlatform();
    const platform = PLATFORMS.find((candidate) => candidate.os === os && candidate.cpu === cpu);
    if (!platform) return yield* Effect.fail(`No supported build target for local platform ${os}-${cpu}`);
    return platform;
  }

  private *buildBasePackage(context: BuildContext): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const packageDir = resolve(context.outDir, BASE_PACKAGE_DIR);
    yield* this.fsOp(fs.makeDirectory(packageDir, { recursive: true }));

    if (context.hasSourceEntrypoint) {
      yield* this.transpileLibrarySource(context, packageDir);
      // The whole source tree ships: the public entrypoint re-exports from internal modules, so
      // both its emitted JS and its types resolve only if those files are present. The `exports`
      // map is what keeps them unreachable as public subpaths.
      yield* this.fsOp(fs.copy(resolve(context.rootDir, "src"), resolve(packageDir, "src")));
      yield* this.removeTests(resolve(packageDir, "src"));
      yield* this.removeTests(resolve(packageDir, "dist"));
    }
    if (context.commandSources.length > 0) {
      yield* this.writeCommandLaunchers(context, packageDir);
    }

    for (const fileName of context.rootFiles) {
      yield* this.fsOp(fs.copyFile(resolve(context.rootDir, fileName), resolve(packageDir, fileName)));
    }

    yield* this.writePackageJson(packageDir, this.generateBasePackageJson(context));
  }

  private *buildPlatformPackage(context: BuildContext, platform: Platform): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const packageDir = resolve(context.outDir, platform.id);
    yield* this.fsOp(fs.makeDirectory(packageDir, { recursive: true }));

    const binaryPath = resolve(packageDir, platformBinaryFile(platform));
    yield* this.dependencies.OSPlatform.compileExecutable({
      entrypoint: multiCallEntrypointPath(context),
      outfile: binaryPath,
      target: platform.target,
      root: context.rootDir,
    });
    yield* this.fsOp(fs.chmod(binaryPath, 0o755));

    yield* this.writePackageJson(packageDir, this.generatePlatformPackageJson(context, platform));
  }

  private *transpileLibrarySource(context: BuildContext, packageDir: string): EffectGen<void, string> {
    const tsconfigPath = resolve(context.rootDir, "tsconfig.json");
    yield* this.ensureTsconfigSourceBoundary(tsconfigPath);

    const { os } = yield* this.dependencies.OSPlatform.getCurrentPlatform();
    const tscPath = resolve(context.rootDir, "node_modules", ".bin", os === "win32" ? "tsc.cmd" : "tsc");
    if (!(yield* this.exists(tscPath))) {
      return yield* Effect.fail("TypeScript is required to emit library source. Install typescript as a devDependency.");
    }

    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: tscPath,
      args: [
        "--project", tsconfigPath,
        "--rootDir", resolve(context.rootDir, "src"),
        "--outDir", resolve(packageDir, "dist"),
        "--pretty", "true",
        "--noEmit", "false",
        "--declaration", "false",
        "--declarationMap", "false",
        "--sourceMap",
        "--rewriteRelativeImportExtensions",
      ],
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      // tsc reports diagnostics on stdout; a build invoked from get-config must keep stdout clean.
      return yield* Effect.fail(`tsc failed with exit code ${result.exitCode}:\n${result.stdout.trim()}`);
    }

  }

  /**
   * Checks the manifest's daemon list against the files, and fails when they disagree.
   *
   * The files are what decide that a daemon exists, so the list adds no information — but it has to be
   * written down anyway, because a file dropped into `src/daemons/` would otherwise acquire a
   * start-at-login registration on every machine that installs the package without the manifest ever
   * saying so. Checking it here rather than at install time means the error reaches the author instead of
   * a user. The dev server makes the editor ask for the same thing while the file is being added; this is
   * the check that holds in CI, where no dev server is running.
   */
  private *resolveDaemons(
    rootDir: string,
    packageJson: PackageJson,
  ): EffectGen<ReadonlyArray<string>, string> {
    const discovered = yield* this.dependencies.Daemon.discoverNames(rootDir);
    const declared = packageJson.jive.library.daemons;

    const unlisted = discovered.filter((name) => !declared.includes(name));
    if (unlisted.length > 0) {
      return yield* Effect.fail(
        `jive.library.daemons does not list ${unlisted.map((name) => `"${name}"`).join(", ")},`
        + ` but ${unlisted.map((name) => `${DAEMON_SOURCE_DIR}/${name}.ts`).join(" and ")} exists.`
        + ` Every daemon has to be listed: installing the package registers it to start at login.`,
      );
    }

    const stale = declared.filter((name) => !discovered.includes(name));
    if (stale.length > 0) {
      return yield* Effect.fail(
        `jive.library.daemons lists ${stale.map((name) => `"${name}"`).join(", ")},`
        + ` but there is no ${stale.map((name) => `${DAEMON_SOURCE_DIR}/${name}.ts`).join(" or ")}.`,
      );
    }

    return discovered;
  }

  /** Tests are part of the repo, not of the package, and a shipped test file is also a test the
   * local runner would execute twice. */
  private *removeTests(dir: string): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    for (const child of yield* this.fsOp(fs.readDirectory(dir))) {
      const path = resolve(dir, child);
      if ((yield* this.fsOp(fs.stat(path))).type === "Directory") {
        yield* this.removeTests(path);
      } else if (TEST_SUFFIXES.some((suffix) => child.endsWith(suffix))) {
        yield* this.fsOp(fs.remove(path));
      }
    }
  }

  private *ensureTsconfigSourceBoundary(tsconfigPath: string): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const originalText = yield* this.fsOp(fs.readFileString(tsconfigPath));
    const updatedText = yield* editJsonc(tsconfigPath, originalText, [
      { path: ["include"], value: TSCONFIG_INCLUDE, insertAt: (properties) => insertAfter(properties, "compilerOptions") },
      { path: ["exclude"], value: TSCONFIG_EXCLUDE, insertAt: (properties) => insertAfter(properties, "include") },
    ]);
    if (updatedText !== originalText) {
      yield* this.fsOp(fs.writeFileString(tsconfigPath, updatedText));
    }
  }

  private *writeCommandLaunchers(context: BuildContext, packageDir: string): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const binDir = resolve(packageDir, BIN_DIR);
    yield* this.fsOp(fs.makeDirectory(binDir, { recursive: true }));

    for (const { command } of context.commandSources) {
      yield* this.fsOp(fs.writeFileString(resolve(binDir, command), yield* renderLauncher(context, COMMAND_LAUNCHER_TEMPLATE, false), { mode: 0o755 }));
    }
    yield* this.fsOp(fs.writeFileString(resolve(packageDir, INSTALL_SCRIPT), yield* renderLauncher(context, COMMAND_LAUNCHER_TEMPLATE, true), { mode: 0o755 }));
  }

  private *writePackageJson(packageDir: string, value: Record<string, unknown>): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    yield* this.fsOp(fs.writeFileString(resolve(packageDir, "package.json"), `${JSON.stringify(value, null, 2)}\n`));
  }

  private generateBasePackageJson(context: BuildContext): Record<string, unknown> {
    const { packageJson, hasSourceEntrypoint, commandSources } = context;
    const generated: Record<string, unknown> = {
      name: packageJson.name,
      version: localBaseVersion(context),
      license: packageJson.license,
      type: Option.getOrElse(packageJson.type, () => "module" as const),
    };

    const description = Option.getOrUndefined(packageJson.description);
    if (description !== undefined) generated["description"] = description;
    const repository = Option.getOrUndefined(context.repositoryUrl);
    if (repository !== undefined) generated["repository"] = { type: "git", url: repository };
    const publishConfig = Option.getOrUndefined(packageJson.publishConfig);
    if (publishConfig !== undefined) generated["publishConfig"] = publishConfig;

    if (hasSourceEntrypoint) {
      generated["main"] = `./dist/${EMITTED_ENTRYPOINT}`;
      generated["module"] = `./dist/${EMITTED_ENTRYPOINT}`;
      generated["types"] = `./${SOURCE_ENTRYPOINT}`;
      generated["exports"] = {
        ".": { types: `./${SOURCE_ENTRYPOINT}`, import: `./dist/${EMITTED_ENTRYPOINT}` },
      };
    }

    const files = [
      ...context.rootFiles,
      ...(hasSourceEntrypoint ? ["dist", "src"] : []),
      ...(commandSources.length > 0 ? [BIN_DIR, INSTALL_SCRIPT] : []),
    ];
    generated["files"] = files;

    if (commandSources.length > 0) {
      generated["scripts"] = { postinstall: `node ./${INSTALL_SCRIPT}` };
      generated["bin"] = Object.fromEntries(commandSources.map(({ command }) => [command, `./${BIN_DIR}/${command}`]));
      generated["optionalDependencies"] = Object.fromEntries(
        context.platforms.map((platform) => [platformAliasName(context, platform), localPlatformVersion(context, platform)]),
      );
    }

    const dependencies = Option.getOrUndefined(packageJson.dependencies);
    if (dependencies !== undefined) generated["dependencies"] = dependencies;
    const peerDependencies = Option.getOrUndefined(packageJson.peerDependencies);
    if (peerDependencies !== undefined) generated["peerDependencies"] = peerDependencies;
    const peerDependenciesMeta = Option.getOrUndefined(packageJson.peerDependenciesMeta);
    if (peerDependenciesMeta !== undefined) generated["peerDependenciesMeta"] = peerDependenciesMeta;

    return generated;
  }

  private generatePlatformPackageJson(context: BuildContext, platform: Platform): Record<string, unknown> {
    const { packageJson } = context;
    const generated: Record<string, unknown> = {
      name: packageJson.name,
      version: localPlatformVersion(context, platform),
      type: Option.getOrElse(packageJson.type, () => "module" as const),
      license: packageJson.license,
      os: [platform.os],
      cpu: [platform.cpu],
      files: [platformBinaryFile(platform)],
    };

    const description = Option.getOrUndefined(packageJson.description);
    if (description !== undefined) generated["description"] = description;
    const repository = Option.getOrUndefined(context.repositoryUrl);
    if (repository !== undefined) generated["repository"] = { type: "git", url: repository };
    const publishConfig = Option.getOrUndefined(packageJson.publishConfig);
    if (publishConfig !== undefined) generated["publishConfig"] = publishConfig;

    return generated;
  }

  private *exists(path: string): EffectGen<boolean, string> {
    return yield* this.fsOp(this.getDependency(FileSystem.FileSystem).exists(path));
  }

  /** Filesystem errors carry a structured PlatformError; every caller here wants it as a message. */
  private fsOp<A>(effect: Effect.Effect<A, { readonly message: string }>): Effect.Effect<A, string> {
    return pipe(effect, Effect.mapError((e) => e.message));
  }
}

function multiCallEntrypointPath(context: BuildContext): string {
  return resolve(context.workDir, "multi-call.ts");
}

function localBaseVersion(context: BuildContext): string {
  return `${context.packageJson.version}-${LOCAL_ENVIRONMENT}`;
}

function localPlatformVersion(context: BuildContext, platform: Platform): string {
  return `${localBaseVersion(context)}-${platform.id}`;
}

function platformAliasName(context: BuildContext, platform: Platform): string {
  return `${context.packageJson.name}-${platform.id}`;
}

function platformBinaryFile(platform: Platform): string {
  return platform.os === "win32" ? `${MULTI_CALL_BINARY}${WINDOWS_EXECUTABLE_SUFFIX}` : MULTI_CALL_BINARY;
}

function* renderLauncher(context: BuildContext, template: string, isInstallScript: boolean): EffectGen<string, string> {
  return yield* Effect.try({
    try: () => ejs.render(template, {
      commandNames: context.commandSources.map(({ command }) => command),
      packageName: context.packageJson.name,
      daemons: context.daemons,
      daemonIdPrefix: DAEMON_ID_PREFIX,
      daemonHomeDir: DAEMON_HOME_DIR,
      daemonRegistrySubdir: DAEMON_REGISTRY_SUBDIR,
      daemonLogSubdir: DAEMON_LOG_SUBDIR,
      repairOnlyFlag: REPAIR_ONLY_FLAG,
      binDir: BIN_DIR,
      installScript: INSTALL_SCRIPT,
      isInstallScript,
      json: (value: unknown) => JSON.stringify(value, null, 2),
      platformBinaries: Object.fromEntries(PLATFORMS.map((platform) => [platform.id, platformBinaryFile(platform)])),
      platformMap: Object.fromEntries(PLATFORMS.map((platform) => [`${platform.os}-${platform.cpu}`, platform.id])),
      platformPackages: Object.fromEntries(PLATFORMS.map((platform) => [platform.id, platformAliasName(context, platform)])),
      windowsExecutableSuffix: WINDOWS_EXECUTABLE_SUFFIX,
    }, { async: false }),
    catch: (e) => `Failed to render the command launcher: ${e instanceof Error ? e.message : String(e)}`,
  });
}

function generateMultiCallEntrypoint(context: BuildContext): string {
  const dispatcherDir = dirname(multiCallEntrypointPath(context));
  const loaders = context.commandSources
    .map(({ command, sourcePath }) => {
      const importPath = toImportPath(relative(dispatcherDir, sourcePath));
      return `  ${JSON.stringify(command)}: () => import(${JSON.stringify(importPath)}),`;
    })
    .join("\n");

  return `import { basename } from "node:path";
const commandLoaders: Record<string, () => Promise<unknown>> = {
${loaders}
};

const invokedPath = process.argv0 || process.argv[1] || "";
const invokedName = basename(invokedPath);
const command = process.platform === "win32" ? invokedName.replace(/\\.exe$/i, "") : invokedName;
const loadCommand = commandLoaders[command];

if (!loadCommand) {
  console.error(\`Unknown ${context.packageJson.name} command "\${command}". Expected one of: \${Object.keys(commandLoaders).sort().join(", ")}\`);
  process.exit(1);
}

await loadCommand();
`;
}

function toImportPath(path: string): string {
  const normalized = path.split("\\").join("/");
  return normalized.startsWith(".") || normalized.startsWith("/") ? normalized : `./${normalized}`;
}

