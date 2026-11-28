import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Result, Schema, pipe } from "effect";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { DaemonImpl } from "../daemon/impl";
import { GitImpl } from "../git/impl";
import { OSPlatformImpl } from "../os-platform/impl";
import { PackageImpl } from "../package/impl";
import { BuilderImpl } from "./impl";
import { PackageJsonSchema, REQUIRED_SCRIPTS } from "../../public/manifest";

const CLI_FIXTURE = join(import.meta.dir, "..", "shell-completion", "fixture-cli.ts");

describe.skipIf(process.platform === "win32")("finding the commands built with Cli", () => {
  test("asks each entrypoint, counts only the one speaking this protocol, and never runs a daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "completion-probe-"));
    mkdirSync(join(root, "src", "entrypoints"), { recursive: true });
    mkdirSync(join(root, "src", "daemons"), { recursive: true });
    writeFileSync(join(root, "src", "entrypoints", "built-with-cli.ts"), `import ${JSON.stringify(CLI_FIXTURE)};\n`);
    // Prints the right answer but fails, as a CLI rejecting an unknown flag might after echoing something.
    writeFileSync(join(root, "src", "entrypoints", "other.ts"), `console.log("1"); process.exit(1);\n`);
    // Exits zero with another protocol's answer, as a Cli from a later jive-abstract-library would.
    writeFileSync(join(root, "src", "entrypoints", "newer.ts"), `console.log("2");\n`);
    const daemonRan = join(root, "daemon-ran");
    writeFileSync(join(root, "src", "daemons", "watcher.ts"), `await Bun.write(${JSON.stringify(daemonRan)}, "yes");\n`);

    const found = await Effect.runPromise(pipe(
      effunct(function* () { return yield* (yield* libraryModules.Builder).listCompletionCommands(root); })(),
      Effect.provide(pipe(
        BuilderImpl.Layer,
        Layer.provideMerge(Layer.mergeAll(GitImpl.mockLayer({}), PackageImpl.mockLayer({}), DaemonImpl.mockLayer({}))),
        Layer.provideMerge(OSPlatformImpl.Layer),
        Layer.provideMerge(BunFileSystem.layer),
      )),
    ));
    expect(found).toEqual(["built-with-cli"]);
    expect(existsSync(daemonRan)).toBe(false);
  });
});

test("a process still running at its timeout is stopped with a nonzero exit", async () => {
  const started = Date.now();
  const result = await Effect.runPromise(pipe(
    effunct(function* () {
      return yield* (yield* libraryModules.OSPlatform).spawnProcess({ command: "sleep", args: ["10"], timeoutMs: 300 });
    })(),
    Effect.provide(OSPlatformImpl.Layer),
  ));
  expect(result.exitCode).not.toBe(0);
  expect(Date.now() - started).toBeLessThan(5_000);
});

describe("copying jive.library.copy into the base package", () => {
  const manifest = (copy: ReadonlyArray<string>) => Schema.decodeUnknownSync(PackageJsonSchema)({
    $schema: "./package.schema.json",
    name: "@acme/docs-only",
    version: "1.2.3",
    license: "MIT",
    scripts: Object.fromEntries(REQUIRED_SCRIPTS.map((script) => [script, "x"])),
    jive: {
      cicd: { deploy: { verb: "Publish", branches: {}, previews: false, sequentially: true }, runsOnPullRequests: false, runsOn: "ubuntu-latest" },
      library: { daemons: [], copy, provisionWithJive: null },
    },
  });

  const build = (root: string, copy: ReadonlyArray<string>) => Effect.runPromise(pipe(
    effunct(function* () { return yield* (yield* libraryModules.Builder).build({ localOnly: true }); })(),
    Effect.result,
    Effect.provide(pipe(
      BuilderImpl.Layer,
      Layer.provideMerge(Layer.mergeAll(
        GitImpl.mockLayer({ *getRemoteOrigin() { return Option.none(); } }),
        PackageImpl.mockLayer({ *load() { return manifest(copy); } }),
        DaemonImpl.mockLayer({ *discoverNames() { return []; } }),
        OSPlatformImpl.mockLayer({ *getCurrentDirectory() { return root; }, *getCurrentPlatform() { return { os: "linux", cpu: "x64" }; } }),
      )),
      Layer.provideMerge(BunFileSystem.layer),
    )),
  ));

  const makePackage = () => {
    const root = mkdtempSync(join(tmpdir(), "jive-copy-build-"));
    for (const file of ["README.md", "LICENSE", "tsconfig.json", "docs/guide.md", "docs/images/logo.svg"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), `contents of ${file}\n`);
    }
    return root;
  };

  test("copies each file and folder verbatim and lists each in files and exports", async () => {
    const root = makePackage();
    const result = await build(root, ["README.md", "LICENSE", "tsconfig.json", "docs"]);
    expect(Result.isSuccess(result)).toBe(true);
    const base = join(root, "dist", "base");
    for (const file of ["README.md", "LICENSE", "tsconfig.json", "docs/guide.md", "docs/images/logo.svg"]) {
      expect({ file, text: readFileSync(join(base, file), "utf8") }).toEqual({ file, text: `contents of ${file}\n` });
    }
    const published = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    expect(published.files).toEqual(["README.md", "LICENSE", "tsconfig.json", "docs"]);
    expect(published.exports).toEqual({
      "./README.md": "./README.md",
      "./LICENSE": "./LICENSE",
      "./tsconfig.json": "./tsconfig.json",
      "./docs/*": "./docs/*",
    });
  });

  test("ships no README or LICENSE that copy does not list", async () => {
    const root = makePackage();
    const result = await build(root, []);
    expect(Result.isSuccess(result)).toBe(true);
    const published = JSON.parse(readFileSync(join(root, "dist", "base", "package.json"), "utf8"));
    expect({ files: published.files, exports: published.exports }).toEqual({ files: [], exports: undefined });
    expect(existsSync(join(root, "dist", "base", "README.md"))).toBe(false);
  });

  test("fails, building nothing, on a reserved or missing entry", async () => {
    const root = makePackage();
    const result = await build(root, ["package.json", "CHANGELOG.md"]);
    expect(Result.isFailure(result) ? result.failure : "").toContain('"package.json" is reserved');
    expect(Result.isFailure(result) ? result.failure : "").toContain('"CHANGELOG.md" does not exist in the package');
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  // The emit step is where an earlier builder wrote include and exclude into tsconfig.json; with no tsc installed here it
  // fails right after, which is enough to see the file untouched.
  test("leaves the package's tsconfig.json as it was", async () => {
    const root = makePackage();
    writeFileSync(join(root, "tsconfig.json"), `{ "extends": "jive-abstract-library/tsconfig.json" }\n`);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "index.ts"), "export const answer = 42;\n");
    await build(root, []);
    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toBe(`{ "extends": "jive-abstract-library/tsconfig.json" }\n`);
  });
});
