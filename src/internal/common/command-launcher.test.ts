import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
function install(platforms: ReadonlyArray<PlatformId>, completionCommands: ReadonlyArray<string> = []): string {
  const root = join(mkdtempSync(join(tmpdir(), "launcher-test-")), "node_modules");
  const base = join(root, PKG);
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", type: "module" }));
  writeFileSync(join(base, "bin", "package.json"), JSON.stringify({ type: "commonjs" }));
  const launcher = join(base, "bin", "demo");
  writeFileSync(launcher, render(completionCommands));
  chmodSync(launcher, 0o755);
  for (const id of platforms) {
    const dir = join(root, `${PKG}-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PKG, version: `1.0.0-${id}` }));
    const binary = join(dir, id === "windows-x64" ? "multi-call-binary.exe" : "multi-call-binary");
    // Records each call when CALLS names a file, so a test can see what the launcher ran.
    writeFileSync(binary, `#!/bin/sh\n[ -n "$CALLS" ] && echo "$@" >> "$CALLS"\necho "${id} $@"\n`);
    chmodSync(binary, 0o755);
  }
  return launcher;
}

function render(completionCommands: ReadonlyArray<string>): string {
  const map = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-arm64": "linux-arm64", "linux-x64": "linux-x64", "win32-x64": "windows-x64" };
  return ejs.render(COMMAND_LAUNCHER_TEMPLATE, {
    commandNames: ["demo"],
    completionCommands,
    completionSkipFlags: ["--compgen", "--completion", "--setup-completion"],
    setUpMissingCompletionFlag: "--setup-completion-if-missing",
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

describe.skipIf(process.platform === "win32")("setting up missing Tab completion from the launcher", () => {
  /**
   * A fresh install per launch: the launcher replaces itself with the binary on its first run, so only the first
   * launch after an install or upgrade runs it. The binary records each call; deciding whether anything needs
   * setting up is the command's own job, tested with ShellCompletion.
   */
  function launch(completionCommands: ReadonlyArray<string>, ...args: Array<string>) {
    const home = mkdtempSync(join(tmpdir(), "launcher-home-"));
    const calls = join(home, "calls");
    const result = spawnSync("node", [install([reported], completionCommands), ...args], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: home, CALLS: calls },
    });
    return { stdout: result.stdout, calls: existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [] };
  }

  test("asks a command built with Cli to set up missing completion, then runs what was typed", () => {
    const { stdout, calls } = launch(["demo"], "hello");
    expect(calls).toEqual(["--setup-completion-if-missing", "hello"]);
    // The command's own stdout reaches the caller; what it printed while checking completion does not.
    expect(stdout.trim()).toBe(`${reported} hello`);
  });

  test("leaves it alone for a shell's or launcher's own call, and for a command not built with Cli", () => {
    expect(launch(["demo"], "--compgen", "").calls).toEqual(["--compgen"]);
    expect(launch(["demo"], "--completion", "zsh").calls).toEqual(["--completion zsh"]);
    expect(launch(["demo"], "--setup-completion").calls).toEqual(["--setup-completion"]);
    expect(launch([], "hello").calls).toEqual(["hello"]);
  });
});
