import { expect, test } from "bun:test";
import { Effect, Layer, Result, pipe } from "effect";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import type { SpawnProcessInput } from "../os-platform/interface";
import { JIVE_CLI_PACKAGE, JiveCliProvisioningImpl } from "./impl";

/** The jive CLI path, with the processes it would start recorded instead of run. */
function provision(exitCodes: ReadonlyArray<number>) {
  const commands: Array<ReadonlyArray<string>> = [];
  const layer = pipe(
    JiveCliProvisioningImpl.Layer,
    Layer.provideMerge(OSPlatformImpl.mockLayer({
      *spawnProcess(input: SpawnProcessInput) {
        commands.push([input.command, ...(input.args ?? [])]);
        return { exitCode: exitCodes[commands.length - 1] ?? 0, stdout: "", stderr: "" };
      },
    })),
  );
  const outcome = Effect.runPromise(pipe(
    effunct(function* () {
      yield* (yield* libraryModules.JiveServer).provisionPackage({ packageName: "@acme/widget" });
    })(),
    Effect.result,
    Effect.provide(layer),
  ));
  return { outcome, commands };
}

test("signs the job in with jive login --cicd, then provisions the package by kind, naming no registry", async () => {
  const { outcome, commands } = provision([0, 0]);
  expect(Result.isSuccess(await outcome)).toBe(true);
  expect(commands).toEqual([
    ["bun", "x", JIVE_CLI_PACKAGE, "login", "--cicd"],
    ["bun", "x", JIVE_CLI_PACKAGE, "provision", "connector-package-registry", "@acme/widget", "--instance", '{"packageName":"@acme/widget"}'],
  ]);
});

test("a failed sign-in stops before provisioning, and the deploy publishes nothing", async () => {
  const { outcome, commands } = provision([1]);
  const result = await outcome;
  expect(Result.isFailure(result) && result.failure).toContain("nothing was published");
  expect(commands.length).toBe(1);
});

test("a refused provisioning fails the deploy", async () => {
  const result = await provision([0, 1]).outcome;
  expect(Result.isFailure(result) && result.failure).toContain("could not provision @acme/widget");
});
