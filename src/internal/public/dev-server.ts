import { Effect, FileSystem, Logger, Schema, Stream, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { layerLive } from "../common/layer";
import { stderrLogger } from "../common/logger";
import { PACKAGE_SCHEMA_FILE } from "../common/constants";
import type { LibraryModules } from "../modules";
import { libraryModules } from "../modules";
import { discoverDaemonNames, packageRootDir } from "./daemons";
import { makePackageJsonSchema } from "./manifest";

/**
 * The dev server: the long-lived half of a Jive template, running for as long as someone is working on a
 * package rather than from every login.
 *
 * A template's build validates; this keeps a package's derived files true while it is being edited. The
 * derived file today is `package.schema.json`, which exists for the **editor** — and an editor needs it the
 * moment a daemon file is added, not at the next build. Generating it during the build meant the schema
 * describing your package was always one build behind your package.
 *
 * Not a daemon, which is the other thing this template can register: its lifetime is a working session, so
 * registering it to start at login would leave it running long after the editor had closed and until the
 * package was uninstalled. Reached as `<template-cli> dev`, which costs nothing in shared code — every
 * entrypoint of a package compiles into the same multi-call binary either way.
 *
 * Everything template-specific arrives through `genPackageJsonSchema`. It is an effect rather than a value
 * so a template can do whatever reaching the answer requires — read its own source tree, call a service,
 * consult a lock file — and the dev server stays the same code for every template.
 */

/** Produces the schema a package built by one template must satisfy. */
export type PackageJsonSchemaGenerator = Effect.Effect<Schema.Top, string, FileSystem.FileSystem>;

export interface DevServerConfig {
  /**
   * The schema to write to `package.schema.json`, regenerated on every change. Defined by the template,
   * not by this dev server: what makes a manifest valid is the one thing each template decides for itself.
   */
  readonly genPackageJsonSchema: PackageJsonSchemaGenerator;
  /**
   * Paths relative to the package root whose contents, when they change, mean the schema may have changed.
   * Directories are watched recursively, and a path that does not exist yet is watched once it appears.
   */
  readonly watchPaths?: ReadonlyArray<string>;
}

const DEFAULT_WATCH_PATHS = ["src", "package.json"] as const;
const DEBOUNCE = "250 millis";

/**
 * This template's own generator: a package built by `jive-abstract-library` must list every daemon in
 * `src/daemons/` and nothing else. That a daemon exists is readable from the files, but listing it cannot
 * be skipped — a file dropped in that directory would otherwise acquire a start-at-login registration on
 * every user's machine without the manifest ever saying so — so the editor is what asks for it.
 */
export const genPackageJsonSchema: PackageJsonSchemaGenerator = Effect.gen(function* () {
  const rootDir = yield* packageRootDir;
  return makePackageJsonSchema(yield* discoverDaemonNames(rootDir));
});

/** Runs a template's dev server until it is interrupted. Never returns normally. */
export async function runDevServer(config: DevServerConfig): Promise<never> {
  const exit = await Effect.runPromiseExit(pipe(
    effunct(devServer)(config),
    Effect.provide(layerLive),
    Effect.provide(Logger.layer([stderrLogger])),
  ));

  if (exit._tag === "Failure") {
    process.stderr.write(`✗ ${String(exit.cause)}\n`);
    process.exit(1);
  }
  process.exit(0);
}

function* devServer(config: DevServerConfig): EffectGen<void, string, LibraryModules | FileSystem.FileSystem> {
  const rootDir = yield* packageRootDir;
  const watchPaths = config.watchPaths ?? DEFAULT_WATCH_PATHS;

  yield* Effect.log(`Watching ${rootDir} (${watchPaths.join(", ")})`);
  yield* regenerate(rootDir, config);

  const fs = yield* FileSystem.FileSystem;
  const changes = Stream.mergeAll(
    watchPaths.map((path) => fs.watch(resolve(rootDir, path), { recursive: true })),
    { concurrency: "unbounded" },
  );

  // A regeneration failure is reported and dropped rather than ending the server: the usual cause is a
  // package.json saved mid-edit, and a watcher that dies on the first malformed save is a watcher that is
  // never running when you need it.
  yield* pipe(
    Stream.runForEach(Stream.debounce(changes, DEBOUNCE), () =>
      pipe(
        effunct(regenerate)(rootDir, config),
        Effect.catchCause((cause) => Effect.log(`Could not regenerate ${PACKAGE_SCHEMA_FILE}: ${String(cause)}`)),
      )),
    Effect.mapError((e) => `Stopped watching ${rootDir}: ${e.message}`),
  );
}

function* regenerate(rootDir: string, config: DevServerConfig): EffectGen<void, string, LibraryModules | FileSystem.FileSystem> {
  const jsonSchema = yield* libraryModules.JsonSchema;
  const schema = yield* config.genPackageJsonSchema;
  if (yield* jsonSchema.writePackageSchema(rootDir, schema)) {
    yield* Effect.log(`Updated ${PACKAGE_SCHEMA_FILE}`);
  }
}
