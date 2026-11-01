import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Duration, Effect, Fiber, Layer, Logger, Option, Result, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { TestClock } from "effect/testing";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { NpmImpl } from "../npm/impl";
import { Availability } from "../npm/interface";
import { OSPlatformImpl } from "../os-platform/impl";
import { JiveCliProvisioningImpl } from "../jive-server/impl";
import type { ProvisionPackageInput } from "../jive-server/interface";
import { DeployerImpl } from "./impl";
import { parseReleaseDownloadTimes } from "./download-times";

const PKG = "@test/demo";
const PLATFORMS = ["darwin-arm64", "linux-x64"] as const;

/**
 * A built release of `PKG` 1.0.0 with two platform packages, and a fake npm that records each publish and
 * each availability check in `events`. `downloadableAfter` says how many checks of each platform package
 * find it not yet downloadable; a platform missing from it never downloads. Each tarball's integrity names
 * the build and the folder it was packed from, so two fixtures with the same `build` pack the same bytes.
 */
function release(input: {
  downloadableAfter: Partial<Record<(typeof PLATFORMS)[number], number>>;
  publishConfig?: object;
  /** Specs (`<name>@<version>`) the fake registry already lists, with contents from another build. */
  published?: ReadonlyArray<string>;
  /** The fake registry, spec to integrity, to share it with an earlier run; publishing adds to it. */
  registry?: Map<string, string>;
  /** Which build this is; the default is `"a"`. */
  build?: string;
  /** A package (`base` or a platform) whose publish fails, as a run cancelled or failing there would stop. */
  failingPublish?: string;
  /** Jive's answer when asked to provision; absent means it accepts. */
  provisionFailure?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "deployer-test-"));
  const write = (folder: string, manifest: object) => {
    mkdirSync(join(dir, "dist", folder), { recursive: true });
    writeFileSync(join(dir, "dist", folder, "package.json"), JSON.stringify(manifest));
  };
  write("base", { name: PKG, version: "1.0.0-local", ...(input.publishConfig === undefined ? {} : { publishConfig: input.publishConfig }) });
  for (const platform of PLATFORMS) write(platform, { name: `${PKG}-${platform}`, version: `1.0.0-local-${platform}` });

  const events: string[] = [];
  const registries: Array<Option.Option<string>> = [];
  const checks = new Map<string, number>();
  const listed = input.registry ?? new Map((input.published ?? []).map((spec) => [spec, "sha512-another-build"]));
  const packed = new Map<string, { spec: string; integrity: string }>();
  const npm = NpmImpl.mockLayer({
    *ensureAvailable() { return "11.0.0"; },
    *pack(packageDir: string) {
      const { name, version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
      const tarball = { path: `${packageDir}.tgz`, integrity: `sha512-${input.build ?? "a"}-${basename(packageDir)}` };
      packed.set(tarball.path, { spec: `${name}@${version}`, integrity: tarball.integrity });
      return tarball;
    },
    *publish({ tarballPath }: { tarballPath: string }) {
      const label = basename(tarballPath, ".tgz");
      events.push(`publish ${label}`);
      if (label === input.failingPublish) return yield* Effect.fail(`npm publish failed for ${tarballPath} with exit code 1`);
      const { spec, integrity } = packed.get(tarballPath)!;
      listed.set(spec, integrity);
    },
    *packageExists() { return true; },
    *versionExists({ spec }: { spec: string }) { return listed.has(spec); },
    *publishedIntegrity({ spec }: { spec: string }) { return Option.fromUndefinedOr(listed.get(spec)); },
    *planRelease({ name, version, registry }: { name: string; version: string; registry: Option.Option<string> }) {
      registries.push(registry);
      events.push(`planRelease ${name}@${version}`);
      return listed.has(`${name}@${version}`)
        ? { deploy: false as const }
        : { deploy: true as const, url: `https://www.npmjs.com/package/${name}/v/${version}` };
    },
    *availability({ spec, registry }: { spec: string; registry: Option.Option<string> }) {
      registries.push(registry);
      const count = (checks.get(spec) ?? 0) + 1;
      checks.set(spec, count);
      events.push(`check ${spec}`);
      const platform = PLATFORMS.find((p) => spec.endsWith(p))!;
      const after = input.downloadableAfter[platform];
      return after !== undefined && count > after
        ? Availability.Downloadable({ tarballUrl: `https://registry.example/${spec}.tgz` })
        : Availability.NotYet({ reason: "the registry does not list it yet" });
    },
  });
  const osPlatform = OSPlatformImpl.mockLayer({ *getCurrentDirectory() { return dir; } });
  const jiveServer = JiveCliProvisioningImpl.mockLayer({
    *provisionPackage({ packageName }: ProvisionPackageInput) {
      events.push(`provision ${packageName}`);
      if (input.provisionFailure !== undefined) return yield* Effect.fail(input.provisionFailure);
    },
  });
  return {
    dir, events, registries, listed,
    layer: pipe(DeployerImpl.Layer, Layer.provideMerge(npm), Layer.provideMerge(jiveServer), Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer)),
  };
}

/**
 * Deploys to `latest` while moving the clock on 10 seconds at a time, up to `advanceSeconds`, and returns
 * the outcome and what was logged. With `writeJobSummary`, the deploy is given a job summary file in the
 * fixture's folder, and its contents are returned. Each step first lets real time pass, so the deploy's file and process
 * work reaches its next sleep before the clock moves.
 */
async function deploy(
  fixture: ReturnType<typeof release>,
  advanceSeconds: number,
  writeJobSummary = false,
  provisionWithJive: Option.Option<{ serverUrl: string }> = Option.none(),
) {
  const jobSummaryPath = join(fixture.dir, "job-summary.md");
  if (writeJobSummary) writeFileSync(jobSummaryPath, "Earlier step's summary\n");
  const logs: string[] = [];
  const capture = Logger.make(({ message }) => { logs.push(Array.isArray(message) ? message.join(" ") : String(message)); });
  const result = await Effect.runPromise(pipe(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(effunct(function* () {
        yield* (yield* libraryModules.Deployer).deploy({
          environment: "latest",
          sourceCommitSha: "abcdef1234",
          maybeJobSummaryPath: writeJobSummary ? Option.some(jobSummaryPath) : Option.none(),
          provisionWithJive,
        });
      })()));
      for (let advanced = 0; advanced < advanceSeconds; advanced += 10) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));
        yield* TestClock.adjust(Duration.seconds(10));
      }
      return yield* Fiber.join(fiber);
    }),
    Effect.provide(fixture.layer),
    Effect.provide(TestClock.layer()),
    Effect.provide(Logger.layer([capture])),
  ));
  return { result, logs, jobSummary: writeJobSummary ? readFileSync(jobSummaryPath, "utf8") : "" };
}

describe("publishing a release", () => {
  test("publishes the base package only after every platform package downloads, logging the wait", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 2 } });
    const { result, logs } = await deploy(fixture, 60, true);
    expect(Result.isSuccess(result)).toBe(true);
    expect(fixture.events).toEqual([
      "publish darwin-arm64",
      "publish linux-x64",
      `check ${PKG}@1.0.0-latest-darwin-arm64`,
      `check ${PKG}@1.0.0-latest-linux-x64`,
      `check ${PKG}@1.0.0-latest-linux-x64`,
      `check ${PKG}@1.0.0-latest-linux-x64`,
      "publish base",
    ]);
    expect(logs).toContain("Waiting for npm's registry to serve all 2 platform packages before publishing the base package (checking every 10 seconds, for up to 15 minutes)");
    expect(logs).toContain(`  Still waiting after 0s for linux-x64 (${PKG}@1.0.0-latest-linux-x64): the registry does not list it yet`);
    expect(logs).toContain(`  - linux-x64 downloads after 20s: https://registry.example/${PKG}@1.0.0-latest-linux-x64.tgz`);
  });

  test("leaves the base package unpublished when a platform package never downloads", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0 } });
    const { result, jobSummary } = await deploy(fixture, 960, true);
    expect(fixture.events).not.toContain("publish base");
    expect(Result.isFailure(result) && result.failure).toBe(
      "After 15 minutes the registry still does not serve every platform package, so the base package was not published:"
      + ` linux-x64 (${PKG}@1.0.0-latest-linux-x64): the registry does not list it yet`,
    );
    expect(jobSummary).toContain("| darwin-arm64 | 0s |\n| linux-x64 | not downloadable after 15 minutes |\n");
  });

  test("appends each platform package's download time to the job summary, slowest last", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 1, "linux-x64": 0 } });
    const { result, jobSummary } = await deploy(fixture, 30, true);
    expect(Result.isSuccess(result)).toBe(true);
    expect(jobSummary).toBe([
      "Earlier step's summary",
      `### Platform package download times: ${PKG}@1.0.0`,
      "",
      "Seconds from publishing every platform package until each downloads from the registry (checked every 10 seconds, for up to 15 minutes).",
      "",
      "| Platform | Downloads after |",
      "| --- | --- |",
      "| linux-x64 | 0s |",
      "| darwin-arm64 | 10s |",
      "",
    ].join("\n"));
  });

  test("logs download times that read back as the release's times", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 2 } });
    const { logs } = await deploy(fixture, 60);
    expect(parseReleaseDownloadTimes(logs)).toEqual([{
      packageName: PKG,
      version: "1.0.0",
      distTag: "latest",
      downloads: [{ platform: "darwin-arm64", seconds: 0 }, { platform: "linux-x64", seconds: 20 }],
    }]);
  });

  test("checks the registry the package publishes to", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, publishConfig: { registry: "https://registry.example/" } });
    const { result, logs } = await deploy(fixture, 10);
    expect(Result.isSuccess(result)).toBe(true);
    expect(fixture.registries).toEqual([Option.some("https://registry.example/"), Option.some("https://registry.example/")]);
    expect(logs).toContain("Waiting for https://registry.example/ to serve all 2 platform packages before publishing the base package (checking every 10 seconds, for up to 15 minutes)");
  });
});

describe("running a release again after an earlier run stopped partway", () => {
  test("publishes what the earlier run left out, skipping platform packages it published with the same contents", async () => {
    const registry = new Map<string, string>();
    const first = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry, failingPublish: "linux-x64" });
    const { result: firstResult } = await deploy(first, 10);
    expect(Result.isFailure(firstResult)).toBe(true);
    expect([...registry.keys()]).toEqual([`${PKG}@1.0.0-latest-darwin-arm64`]);

    const rerun = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry });
    const { result, logs } = await deploy(rerun, 10);
    expect(Result.isSuccess(result)).toBe(true);
    expect(rerun.events).toEqual([
      "publish linux-x64",
      `check ${PKG}@1.0.0-latest-darwin-arm64`,
      `check ${PKG}@1.0.0-latest-linux-x64`,
      "publish base",
    ]);
    expect(logs).toContain("  - darwin-arm64 is already on npm's registry with this build's contents, so it is not published again");
    expect(logs).toContain("Published 2 packages");
    expect([...registry.keys()].sort()).toEqual([`${PKG}@1.0.0`, `${PKG}@1.0.0-latest-darwin-arm64`, `${PKG}@1.0.0-latest-linux-x64`]);
  });

  test("publishes only the base package when the earlier run published every platform package", async () => {
    const registry = new Map<string, string>();
    const first = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry, failingPublish: "base" });
    await deploy(first, 10);

    const rerun = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry });
    const { result } = await deploy(rerun, 10);
    expect(Result.isSuccess(result)).toBe(true);
    expect(rerun.events.filter((event) => event.startsWith("publish"))).toEqual(["publish base"]);
  });

  test("fails before provisioning or publishing anything when a published platform package holds another build", async () => {
    const registry = new Map<string, string>();
    const first = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry, failingPublish: "linux-x64" });
    await deploy(first, 10);

    const rerun = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, registry, build: "b" });
    const { result } = await deploy(rerun, 10, false, Option.some({ serverUrl: "https://jive.example" }));
    expect(rerun.events).toEqual([]);
    expect(Result.isFailure(result) && result.failure).toBe(
      "npm's registry already lists 1 of this release's platform packages with contents other than this build's, so nothing was published:"
      + ` darwin-arm64 (${PKG}@1.0.0-latest-darwin-arm64): npm's registry has sha512-a-darwin-arm64, this build is sha512-b-darwin-arm64.`
      + " npm never replaces a published version, so release this build under a new version in package.json.",
    );
  });

  test("publishes nothing when the base package is already listed, since an earlier run finished the release", async () => {
    const fixture = release({ downloadableAfter: {}, published: [`${PKG}@1.0.0`] });
    const { result, logs } = await deploy(fixture, 0);
    expect(Result.isSuccess(result)).toBe(true);
    expect(fixture.events).toEqual([]);
    expect(logs).toContain(`${PKG}@1.0.0 is already on npm's registry, so an earlier run released it and there is nothing to publish`);
  });
});

describe("provisioning with Jive", () => {
  const server = Option.some({ serverUrl: "https://jive.example" });

  test("asks Jive once, after packing and before any package is published", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 } });
    const { result } = await deploy(fixture, 10, false, server);
    expect(Result.isSuccess(result)).toBe(true);
    expect(fixture.events.slice(0, 3)).toEqual([
      `provision ${PKG}`,
      "publish darwin-arm64",
      "publish linux-x64",
    ]);
    expect(fixture.events.filter((event) => event.startsWith("provision"))).toHaveLength(1);
  });

  test("publishes nothing when Jive refuses", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 }, provisionFailure: "Jive refused: not registered" });
    const { result } = await deploy(fixture, 10, false, server);
    expect(Result.isFailure(result) && result.failure).toBe("Jive refused: not registered");
    expect(fixture.events.filter((event) => event.startsWith("publish"))).toEqual([]);
  });

  test("does not ask Jive when the package has not opted in", async () => {
    const fixture = release({ downloadableAfter: { "darwin-arm64": 0, "linux-x64": 0 } });
    const { result } = await deploy(fixture, 10);
    expect(Result.isSuccess(result)).toBe(true);
    expect(fixture.events.filter((event) => event.startsWith("provision"))).toEqual([]);
  });
});

describe("planning a release", () => {
  const plan = (fixture: ReturnType<typeof release>, environment: string) => Effect.runPromise(pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.Deployer).plan({ environment, sourceCommitSha: "abcdef1234" });
    })(),
    Effect.provide(fixture.layer),
    Effect.provide(Logger.layer([])),
  ));

  test("asks npm about the base package at this environment's version, and returns its answer", async () => {
    const fixture = release({ downloadableAfter: {}, published: [`${PKG}@1.0.0`] });
    expect(await plan(fixture, "latest")).toEqual({ deploy: false });
    expect(fixture.events).toEqual([`planRelease ${PKG}@1.0.0`]);
  });

  test("checks the version the environment stamps", async () => {
    const fixture = release({ downloadableAfter: {}, published: [`${PKG}@1.0.0`] });
    expect(await plan(fixture, "preview")).toEqual({ deploy: true, url: `https://www.npmjs.com/package/${PKG}/v/1.0.0-preview-abcdef12` });
    expect(fixture.events).toEqual([`planRelease ${PKG}@1.0.0-preview-abcdef12`]);
  });

  test("asks the registry the package publishes to, or npm's configured one", async () => {
    const custom = release({ downloadableAfter: {}, publishConfig: { registry: "https://registry.example/" } });
    await plan(custom, "latest");
    expect(custom.registries).toEqual([Option.some("https://registry.example/")]);
    const configured = release({ downloadableAfter: {} });
    await plan(configured, "latest");
    expect(configured.registries).toEqual([Option.none()]);
  });
});
