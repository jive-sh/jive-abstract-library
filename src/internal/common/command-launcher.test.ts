import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ejs from "ejs";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, pipe } from "effect";
import { effunct } from "effective-modules";
import { libraryModules } from "../modules";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import { ShellCompletionImpl } from "../modules/shell-completion/impl";
import { COMPLETION_LOCATIONS } from "../modules/shell-completion/locations";
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
    completionLocations: COMPLETION_LOCATIONS,
    completionSkipFlags: ["--compgen", "--setup-completion", "--remove-completion"],
    setUpCompletionFlag: "--setup-completion",
    removeCompletionFlag: "--remove-completion",
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
  /** A user's machine: its own home, the given SHELL, no CI, and the platform binary recording its calls. */
  function machine(shell: string, extraEnv: Record<string, string> = {}) {
    const home = mkdtempSync(join(tmpdir(), "launcher-home-"));
    const calls = join(home, "calls");
    const env = { PATH: process.env["PATH"] ?? "", HOME: home, SHELL: shell, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config"), CALLS: calls, ...extraEnv };
    // A fresh install per launch: the launcher replaces itself with the binary on its first run, so only
    // the first launch after an install or upgrade runs it.
    const launch = (...args: Array<string>) => {
      const result = spawnSync("node", [install([reported], ["demo"]), ...args], { encoding: "utf8", env });
      return { stderr: result.stderr, calls: existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [] };
    };
    return { home, env, launch };
  }

  test("sets it up when the startup file does not load it, saying where, then runs the command", () => {
    const { home, launch } = machine("/bin/zsh");
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    const { stderr, calls } = launch("hello");
    expect(stderr).toBe(`Setting up Tab completion for demo in ${join(home, ".zshrc")} (turn it off with: demo --remove-completion)\n`);
    expect(calls).toEqual(["--setup-completion", "hello"]);
  });

  test("does nothing more once the startup file loads it and the script is there", () => {
    const { home, launch } = machine("/bin/zsh");
    mkdirSync(join(home, ".jive", "completions"), { recursive: true });
    writeFileSync(join(home, ".jive", "completions", "demo.zsh"), "");
    writeFileSync(join(home, ".zshrc"), "# begin demo completion\n. x\n# end demo completion\n");
    expect(launch("hello")).toEqual({ stderr: "", calls: ["hello"] });
  });

  test("leaves it alone when turned off, on a build agent, for Tab itself, and for a shell it has none for", () => {
    const off = machine("/bin/zsh");
    mkdirSync(join(off.home, ".jive", "completions"), { recursive: true });
    writeFileSync(join(off.home, ".jive", "completions", "demo.off"), "");
    expect(off.launch("hello").calls).toEqual(["hello"]);
    expect(machine("/bin/zsh", { CI: "true" }).launch("hello").calls).toEqual(["hello"]);
    expect(machine("/bin/zsh").launch("--compgen", "").calls).toEqual(["--compgen"]);
    expect(machine("/bin/zsh").launch("--remove-completion").calls).toEqual(["--remove-completion"]);
    expect(machine("/usr/bin/nu").launch("hello").calls).toEqual(["hello"]);
  });

  test("a command not built with Cli is never asked", () => {
    const home = mkdtempSync(join(tmpdir(), "launcher-home-"));
    const calls = join(home, "calls");
    const launcher = install([reported], []);
    spawnSync("node", [launcher, "hello"], { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "", HOME: home, SHELL: "/bin/zsh", CALLS: calls } });
    expect(readFileSync(calls, "utf-8").trim().split("\n")).toEqual(["hello"]);
  });

  test("looks where --setup-completion writes, for every shell", async () => {
    for (const shell of COMPLETION_LOCATIONS.shells) {
      const { home, env, launch } = machine(`/bin/${shell}`);
      const written = await Effect.runPromise(pipe(
        effunct(function* () { return yield* (yield* libraryModules.ShellCompletion).setUp("demo"); })(),
        Effect.provide(pipe(
          ShellCompletionImpl.Layer,
          Layer.provideMerge(OSPlatformImpl.mockLayer({
            *readEnv(name: string) { return Option.fromUndefinedOr((env as Record<string, string | undefined>)[name]); },
            *getHomeDirectory() { return home; },
            *getCurrentPlatform() { return { os: process.platform, cpu: process.arch }; },
          })),
          Layer.provideMerge(BunFileSystem.layer),
        )),
      ));
      // What the module wrote is exactly what the launcher counts as set up...
      expect(launch("hello")).toEqual({ stderr: "", calls: ["hello"] });
      // ...and with it gone, the launcher names the same place the module writes to.
      const where = Option.getOrElse(written.startupFile, () => written.scriptPath);
      rmSync(where);
      expect(launch("again").stderr).toContain(`demo in ${where} `);
    }
  });
});
