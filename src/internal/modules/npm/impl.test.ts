import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Option, pipe } from "effect";
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
