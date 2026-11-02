import { Effect, Option } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import type { EffectGen } from "effective-modules";
import { PACKAGE_SCHEMA_FILE } from "../../common/constants";
import { LOCAL_ENVIRONMENT } from "../../public/manifest";
import { packageRootDir } from "../../public/daemons";
import { genPackageJsonSchema } from "../../public/dev-server";
import { libraryModules, type LibraryModules } from "../../modules";
import { makeCicdCommand } from "../../common/command";

/** Builds the package folders under dist/, writes package.schema.json, then installs the result on this machine. */
export function* buildAndInstall(): EffectGen<void, string, LibraryModules.Builder | LibraryModules.JsonSchema | LibraryModules.Deployer> {
  yield* (yield* libraryModules.Builder).build({ localOnly: false });
  // The editor checks package.json against this file; writing it here means it exists after any build, not only
  // while `jive-library dev` runs.
  if (yield* (yield* libraryModules.JsonSchema).writePackageSchema(yield* packageRootDir, yield* Effect.provide(genPackageJsonSchema, BunFileSystem.layer))) {
    yield* Effect.log(`Updated ${PACKAGE_SCHEMA_FILE}`);
  }
  // Installing here means a later audit sees the package exactly as a consumer machine would.
  yield* (yield* libraryModules.Deployer).deploy({
    environment: LOCAL_ENVIRONMENT,
    sourceCommitSha: "",
    maybeJobSummaryPath: Option.none(),
    provisionWithJive: Option.none(),
  });
  yield* Effect.log("Build complete");
}

export const build = makeCicdCommand(
  "build",
  "build the package folders under dist/, write package.schema.json, and install the result locally",
  buildAndInstall,
);
