import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, pipe } from "effect";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { DaemonImpl } from "../daemon/impl";
import { GitImpl } from "../git/impl";
import { OSPlatformImpl } from "../os-platform/impl";
import { PackageImpl } from "../package/impl";
import { BuilderImpl } from "./impl";

const CLI_FIXTURE = join(import.meta.dir, "..", "shell-completion", "fixture-cli.ts");

describe.skipIf(process.platform === "win32")("finding the commands built with Cli", () => {
  test("asks each entrypoint, counts only the one built with Cli, and never runs a daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "completion-probe-"));
    mkdirSync(join(root, "src", "entrypoints"), { recursive: true });
    mkdirSync(join(root, "src", "daemons"), { recursive: true });
    writeFileSync(join(root, "src", "entrypoints", "built-with-cli.ts"), `import ${JSON.stringify(CLI_FIXTURE)};\n`);
    // Prints the right word but fails, as a CLI rejecting an unknown flag does after echoing it.
    writeFileSync(join(root, "src", "entrypoints", "other.ts"), `console.log("--setup-completion"); process.exit(1);\n`);
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
