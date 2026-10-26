import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Result, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { FetchHttpClient } from "effect/http";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import type { SpawnProcessInput } from "../os-platform/interface";
import { NpmImpl } from "./impl";
import { Availability } from "./interface";

const SPEC = "@test/demo@1.0.0-latest-linux-x64";

/** A tarball host answering every request with `status`. */
const host = (status: number) => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status }) });
const missing = host(404);
const served = host(200);
afterAll(() => {
  missing.stop(true);
  served.stop(true);
});

/** Asks for `SPEC`'s availability with `npm view` answering `exitCode` and `stdout`; returns it and npm's arguments. */
async function availability(input: { exitCode: number; stdout: string; registry?: string }) {
  const argv: string[] = [];
  const osPlatform = OSPlatformImpl.mockLayer({
    *spawnProcess(spawn: SpawnProcessInput) {
      argv.push(spawn.command, ...(spawn.args ?? []));
      return { exitCode: input.exitCode, stdout: input.stdout, stderr: input.exitCode === 0 ? "" : "npm error code E404" };
    },
  });
  const result = await Effect.runPromise(pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.Npm).availability({ spec: SPEC, registry: Option.fromUndefinedOr(input.registry) });
    })(),
    Effect.provide(pipe(NpmImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer), Layer.provideMerge(FetchHttpClient.layer))),
  ));
  return { result, argv };
}

describe("availability", () => {
  test("is not yet while the registry does not list the version", async () => {
    const { result } = await availability({ exitCode: 1, stdout: "" });
    expect(result).toEqual(Availability.NotYet({ reason: "the registry does not list it yet" }));
  });

  test("is not yet while the listed tarball does not download", async () => {
    const url = `http://127.0.0.1:${missing.port}/demo.tgz`;
    const { result } = await availability({ exitCode: 0, stdout: JSON.stringify(url) });
    expect(result).toEqual(Availability.NotYet({ reason: `the registry lists it, but ${url} answers 404` }));
  });

  test("is downloadable once the tarball downloads", async () => {
    const url = `http://127.0.0.1:${served.port}/demo.tgz`;
    const { result } = await availability({ exitCode: 0, stdout: JSON.stringify(url) });
    expect(result).toEqual(Availability.Downloadable({ tarballUrl: url }));
  });

  test("asks the registry the package publishes to, or npm's configured one", async () => {
    expect((await availability({ exitCode: 1, stdout: "", registry: "https://registry.example/" })).argv.slice(-2))
      .toEqual(["--registry", "https://registry.example/"]);
    expect((await availability({ exitCode: 1, stdout: "" })).argv).not.toContain("--registry");
  });
});

/** Asks whether `SPEC` is published, with `npm view` answering `exitCode`, `stdout` and `stderr`; returns the outcome and npm's arguments. */
async function versionExists(input: { exitCode: number; stdout: string; stderr: string; registry?: string }) {
  const argv: string[] = [];
  const osPlatform = OSPlatformImpl.mockLayer({
    *spawnProcess(spawn: SpawnProcessInput) {
      argv.push(spawn.command, ...(spawn.args ?? []));
      return { exitCode: input.exitCode, stdout: input.stdout, stderr: input.stderr };
    },
  });
  const result = await Effect.runPromise(pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.Npm).versionExists({ spec: SPEC, registry: Option.fromUndefinedOr(input.registry) });
    })(),
    Effect.provide(pipe(NpmImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer), Layer.provideMerge(FetchHttpClient.layer))),
    Effect.result,
  ));
  return { result, argv };
}

describe("versionExists", () => {
  test("is true when the registry lists the version", async () => {
    const { result } = await versionExists({ exitCode: 0, stdout: '"1.0.0-latest-linux-x64"\n', stderr: "" });
    expect(result).toEqual(Result.succeed(true));
  });

  test("is false when the registry has the package but not the version, or no package at all", async () => {
    for (const stderr of ["npm error code E404\nnpm error 404 No match found for version 1.0.0", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@test%2fdemo"]) {
      expect((await versionExists({ exitCode: 1, stdout: "", stderr })).result).toEqual(Result.succeed(false));
    }
  });

  test("fails on any other npm error rather than guessing", async () => {
    const { result } = await versionExists({ exitCode: 1, stdout: "", stderr: "npm error code ETIMEDOUT" });
    expect(Result.isFailure(result) && result.failure).toBe(`npm view failed for ${SPEC}:\nnpm error code ETIMEDOUT`);
  });

  test("fails when npm succeeds without printing a version", async () => {
    const { result } = await versionExists({ exitCode: 0, stdout: "", stderr: "" });
    expect(Result.isFailure(result)).toBe(true);
  });

  test("asks the registry the package publishes to, or npm's configured one", async () => {
    expect((await versionExists({ exitCode: 1, stdout: "", stderr: "E404", registry: "https://registry.example/" })).argv.slice(-2))
      .toEqual(["--registry", "https://registry.example/"]);
    expect((await versionExists({ exitCode: 1, stdout: "", stderr: "E404" })).argv).not.toContain("--registry");
  });
});
