import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ejs from "ejs";
import { COMMAND_LAUNCHER_TEMPLATE } from "./command-launcher";

const PKG = "@test/demo";
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-x64"] as const;
type PlatformId = (typeof PLATFORMS)[number];

/** The platform id that `node`, as run by these tests, reports. */
const reported = (() => {
  const result = spawnSync("node", ["-p", "process.platform + '-' + process.arch"], { encoding: "utf8" });
  return result.stdout.trim().replace("win32", "windows") as PlatformId;
})();
const other = PLATFORMS.find((id) => id !== reported)!;

/**
 * A global install the way a package manager lays it out: the base package with its launcher in `bin/`,
 * and beside it the platform packages it chose to install. Each "binary" is a shell script that says
 * which platform package it came from.
 */
function install(platforms: ReadonlyArray<PlatformId>): string {
  const root = join(mkdtempSync(join(tmpdir(), "launcher-test-")), "node_modules");
  const base = join(root, PKG);
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", type: "module" }));
  writeFileSync(join(base, "bin", "package.json"), JSON.stringify({ type: "commonjs" }));
  const launcher = join(base, "bin", "demo");
  writeFileSync(launcher, render());
  chmodSync(launcher, 0o755);
  for (const id of platforms) {
    const dir = join(root, `${PKG}-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PKG, version: `1.0.0-${id}` }));
    const binary = join(dir, id === "windows-x64" ? "multi-call-binary.exe" : "multi-call-binary");
    writeFileSync(binary, `#!/bin/sh\necho "${id} $@"\n`);
    chmodSync(binary, 0o755);
  }
  return launcher;
}

function render(): string {
  const map = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-arm64": "linux-arm64", "linux-x64": "linux-x64", "win32-x64": "windows-x64" };
  return ejs.render(COMMAND_LAUNCHER_TEMPLATE, {
    commandNames: ["demo"],
    packageName: PKG,
    daemons: [],
    daemonIdPrefix: "test",
    daemonHomeDir: ".jive-test",
    daemonRegistrySubdir: "daemons",
    daemonLogSubdir: "logs",
    repairOnlyFlag: "--repair-only",
    binDir: "bin",
    installScript: "install.cjs",
    isInstallScript: false,
    json: (value: unknown) => JSON.stringify(value, null, 2),
    platformBinaries: Object.fromEntries(PLATFORMS.map((id) => [id, id === "windows-x64" ? "multi-call-binary.exe" : "multi-call-binary"])),
    platformMap: map,
    platformPackages: Object.fromEntries(PLATFORMS.map((id) => [id, `${PKG}-${id}`])),
    windowsExecutableSuffix: ".exe",
  });
}

const run = (launcher: string) => spawnSync("node", [launcher, "hello"], { encoding: "utf8" });

describe.skipIf(process.platform === "win32")("command launcher", () => {
  test("uses the one installed platform package, even when it is not the one Node reports", () => {
    // Panda: bun (native arm64) installed darwin-arm64, and the launcher ran under Node reporting "x64".
    const result = run(install([other]));
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`${other} hello`);
  });

  test("uses the installed package that matches Node when there are several", () => {
    const result = run(install([other, reported]));
    expect(result.stdout.trim()).toBe(`${reported} hello`);
  });

  test("names every platform package when none is installed", () => {
    const result = run(install([]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`None of ${PKG}'s platform packages is installed`);
    expect(result.stderr).toContain(`${PKG}-darwin-arm64`);
  });

  test("refuses to guess between several when none matches Node", () => {
    const others = PLATFORMS.filter((id) => id !== reported && id !== "windows-x64").slice(0, 2);
    const result = run(install(others));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Several of ${PKG}'s platform packages are installed`);
  });
});
