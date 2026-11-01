import { Effect } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules } from "../index";
import type { IJiveServer, ProvisionPackageInput } from "./interface";

/** The jive CLI the deploy runs, by exact version so a release of jive never changes a deploy by itself. */
export const JIVE_CLI_PACKAGE = "@jive-sh/jive@0.4.1";

/** A package registry is the `connector-package-registry` kind; the organization's configuration picks npm. */
const PACKAGE_REGISTRY_KIND = "connector-package-registry";

/**
 * Provisions through the jive CLI (Alex, 2026-11-01: "We have a deploy hook in CI. That should do a `jive login
 * --cicd` then `jive provision` for a given resource"): `jive login --cicd` exchanges the job's ID token for a
 * session, then `jive provision connector-package-registry <name>` makes sure the package exists. The CLI names
 * only the kind and reaches the server its own release points at.
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
