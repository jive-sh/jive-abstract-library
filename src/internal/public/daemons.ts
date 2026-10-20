import { Effect, FileSystem } from "effect";
import { basename, resolve } from "node:path";
import { DAEMON_SOURCE_DIR } from "../common/constants";

/**
 * Daemon discovery, as a plain effect rather than a module method.
 *
 * It is the one answer to "which daemons does this package have", and three callers need it: the build,
 * which validates the declarations against it; the schema generator, which makes those declarations
 * mandatory; and the watch daemon, which re-runs it whenever the directory changes. A module method
 * would have put it behind the internal module graph, where a consuming template's own
 * `genPackageJsonSchema` could not reach it.
 */

const SOURCE_SUFFIX = ".ts";
const TEST_SUFFIX = ".test.ts";

export function discoverDaemonNames(
  rootDir: string,
): Effect.Effect<ReadonlyArray<string>, string, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = resolve(rootDir, DAEMON_SOURCE_DIR);
    if (!(yield* fs.exists(dir))) return [];

    const children = yield* fs.readDirectory(dir);
    return [...children]
      .filter((child) => child.endsWith(SOURCE_SUFFIX) && !child.endsWith(TEST_SUFFIX))
      .map((child) => basename(child, SOURCE_SUFFIX))
      .sort();
  }).pipe(Effect.mapError((e) => (typeof e === "string" ? e : e.message)));
}

/** The package being worked on: the working directory, since the dev server is run from a package root. */
export const packageRootDir: Effect.Effect<string> = Effect.sync(() => process.cwd());
