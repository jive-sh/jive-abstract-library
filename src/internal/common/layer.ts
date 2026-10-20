import { Layer, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { BuilderImpl } from "../modules/builder/impl";
import { DaemonImpl } from "../modules/daemon/impl";
import { DeployerImpl } from "../modules/deployer/impl";
import { GitImpl } from "../modules/git/impl";
import { JsonSchemaImpl } from "../modules/json-schema/impl";
import { NpmImpl } from "../modules/npm/impl";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import { PackageImpl } from "../modules/package/impl";

/**
 * Every module this package owns, composed most-dependent first. Commands and daemons are small enough
 * that splitting the graph per entrypoint would only make the wiring harder to follow than it is useful.
 */
export const layerLive = pipe(
  DeployerImpl.Layer,
  Layer.provideMerge(BuilderImpl.Layer),
  Layer.provideMerge(DaemonImpl.Layer),
  Layer.provideMerge(NpmImpl.Layer),
  Layer.provideMerge(JsonSchemaImpl.Layer),
  Layer.provideMerge(PackageImpl.Layer),
  Layer.provideMerge(GitImpl.Layer),
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
  Layer.provideMerge(FetchHttpClient.layer),
) satisfies Layer.Layer<any, any, never>;
