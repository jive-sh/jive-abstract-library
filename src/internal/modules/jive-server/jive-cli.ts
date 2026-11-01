import { Effect, type Layer } from "effect";
import type { HttpClient } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules, type LibraryModules } from "../index";
import { JiveServerImpl } from "./impl";
import type { IJiveServer, ProvisionPackageInput } from "./interface";

/**
 * Which way a deploy provisions its package (Alex, 2026-11-01: "We have a deploy hook in CI. That should do a `jive
 * login --cicd` then `jive provision` for a given resource"). `false` keeps the direct `packages:provision` call
 * until `@jive-sh/server` deploys its `provision`; flipping it to `true`, and releasing, moves every deploy onto the
 * jive CLI.
 */
export const PROVISION_THROUGH_JIVE_CLI = false;

/** The jive CLI the deploy runs, by exact version so a release of jive never changes a deploy by itself. */
export const JIVE_CLI_PACKAGE = "@jive-sh/jive@0.4.0";

/** A package registry is the `connector-package-registry` kind; the organization's configuration picks npm. */
const PACKAGE_REGISTRY_KIND = "connector-package-registry";

/**
 * Provisions through the jive CLI: `jive login --cicd` exchanges the job's ID token for a session, then `jive
 * provision connector-package-registry <name>` makes sure the package exists. The CLI names only the kind, so
 * `registry` is not passed on, and it reaches the server its own release points at, so `serverUrl` is not either.
 */
export class JiveCliProvisioningImpl extends implementing(libraryModules.JiveServer)
  .uses(libraryModules.OSPlatform)
  implements IJiveServer {
  *provisionPackage(input: ProvisionPackageInput): EffectGen<void, string> {
    yield* Effect.log(`Provisioning ${input.packageName} through ${JIVE_CLI_PACKAGE} (${PACKAGE_REGISTRY_KIND})`);
    yield* this.jive(["login", "--cicd"], "sign this deploy job in to Jive");
    yield* this.jive(
      ["provision", PACKAGE_REGISTRY_KIND, input.packageName, "--instance", JSON.stringify({ packageName: input.packageName })],
      `provision ${input.packageName}`,
    );
  }

  private *jive(args: ReadonlyArray<string>, purpose: string): EffectGen<void, string> {
    const { exitCode } = yield* this.dependencies.OSPlatform.spawnProcess({
      command: "bun",
      args: ["x", JIVE_CLI_PACKAGE, ...args],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (exitCode !== 0) {
      return yield* Effect.fail(`jive could not ${purpose} (\`jive ${args.slice(0, 2).join(" ")}\` exited ${exitCode}), so nothing was published`);
    }
  }
}

/** The provisioning path `PROVISION_THROUGH_JIVE_CLI` picks; every layer that provisions uses this one. */
export const provisioningLayer: Layer.Layer<LibraryModules.JiveServer, never, LibraryModules.PipelineIdentity | LibraryModules.OSPlatform | HttpClient.HttpClient> =
  PROVISION_THROUGH_JIVE_CLI ? JiveCliProvisioningImpl.Layer : JiveServerImpl.Layer;