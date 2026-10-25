import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Result } from "effect";
import { effunct } from "effective-modules";
import { installedPackageLayer } from "../../public/upgrade";
import { libraryModules } from "../index";
import type { Install, PackageManagerName } from "./interface";

const PKG = "@jive-sh/skill-sync";
const TAGS = { latest: "0.4.5", "latest-darwin-arm64": "0.4.5-latest-darwin-arm64" };

/** A directory holding a fake `name` command that prints `stdout` and exits with `code`, as the only thing on PATH. */
function fakeManager(name: PackageManagerName, stdout: string, code = 0): Install {
  const dir = mkdtempSync(join(tmpdir(), "fake-manager-"));
  writeFileSync(join(dir, "out"), stdout);
  writeFileSync(join(dir, name), `#!/bin/sh\necho "$@" > "${dir}/args"\ncat "${dir}/out"\nexit ${code}\n`);
  chmodSync(join(dir, name), 0o755);
  return { packageManager: name, scope: "global", cwd: dir, packageDir: dir, env: { PATH: `${dir}:/bin:/usr/bin` } };
}

const distTags = (install: Install) => Effect.runPromise(Effect.result(Effect.provide(
  effunct(function* () {
    return yield* (yield* libraryModules.InstalledPackage).distTags({ packageName: PKG, install });
  })(),
  installedPackageLayer,
)));

describe.skipIf(process.platform === "win32")("distTags", () => {
  test("reads npm's, pnpm's and bun's JSON", async () => {
    for (const name of ["npm", "pnpm", "bun"] as const) {
      expect(await distTags(fakeManager(name, JSON.stringify(TAGS, null, 2)))).toEqual(Result.succeed(TAGS));
    }
  });

  test("reads yarn's event lines, past its warnings", async () => {
    const stdout = `${JSON.stringify({ type: "warning", data: "package.json: No license field" })}\n${JSON.stringify({ type: "inspect", data: TAGS })}\n`;
    expect(await distTags(fakeManager("yarn", stdout))).toEqual(Result.succeed(TAGS));
  });

  test("a yarn error is a failure even though yarn exits zero", async () => {
    const result = await distTags(fakeManager("yarn", `${JSON.stringify({ type: "error", data: "Received invalid response from npm." })}\n`));
    expect(Result.isFailure(result) && result.failure).toContain("Received invalid response from npm.");
  });

  test("a failing manager's output is in the failure", async () => {
    const result = await distTags(fakeManager("npm", "npm error code E404", 1));
    expect(Result.isFailure(result) && result.failure).toContain("npm error code E404");
  });
});

describe("platform", () => {
  const platformOf = (install: Install) => Effect.runPromise(Effect.provide(
    effunct(function* () {
      return yield* (yield* libraryModules.InstalledPackage).platform({ packageName: PKG, install });
    })(),
    installedPackageLayer,
  ));

  test("is the platform package installed beside the package", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-test-"));
    for (const dir of [PKG, `${PKG}-linux-arm64`]) {
      mkdirSync(join(root, "node_modules", dir), { recursive: true });
      writeFileSync(join(root, "node_modules", dir, "package.json"), JSON.stringify({ name: PKG }));
    }
    const install: Install = { packageManager: "bun", scope: "global", cwd: root, packageDir: join(root, "node_modules", PKG), env: {} };
    expect(await platformOf(install)).toEqual(Option.some("linux-arm64"));
  });

  test("is none when no platform package is installed", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-test-"));
    mkdirSync(join(root, "node_modules", PKG), { recursive: true });
    const install: Install = { packageManager: "bun", scope: "global", cwd: root, packageDir: join(root, "node_modules", PKG), env: {} };
    expect(await platformOf(install)).toEqual(Option.none());
  });
});
