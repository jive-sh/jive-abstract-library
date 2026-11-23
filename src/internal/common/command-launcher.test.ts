import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import ejs from "ejs";
import { COMMAND_LAUNCHER_TEMPLATE } from "./command-launcher";
import { DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR, DAEMON_REGISTRY_SUBDIR } from "./constants";
import { Effect, Layer, Logger, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct } from "effective-modules";
import { libraryModules } from "../modules";
import { DaemonImpl } from "../modules/daemon/impl";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import type { SpawnProcessInput } from "../modules/os-platform/interface";

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
 * A global install the way a package manager lays it out: the base package with its launcher in `bin/` and its
 * `install.cjs`, and beside it the platform packages it chose to install. Each "binary" is a shell script that says
 * which platform package it came from.
 */
function install(input: {
  readonly platforms: ReadonlyArray<PlatformId>;
  readonly completionCommands?: ReadonlyArray<string>;
  readonly daemons?: ReadonlyArray<string>;
}) {
  const root = join(mkdtempSync(join(tmpdir(), "launcher-test-")), "node_modules");
  const base = join(root, PKG);
  const daemons = input.daemons ?? [];
  const rendered = { completionCommands: input.completionCommands ?? [], daemons };
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0", type: "module" }));
  writeFileSync(join(base, "bin", "package.json"), JSON.stringify({ type: "commonjs" }));
  const launcher = join(base, "bin", "demo");
  writeFileSync(launcher, render({ ...rendered, isInstallScript: false }));
  chmodSync(launcher, 0o755);
  const installScript = join(base, "install.cjs");
  writeFileSync(installScript, render({ ...rendered, isInstallScript: true }));
  for (const id of input.platforms) {
    const dir = join(root, `${PKG}-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PKG, version: `1.0.0-${id}` }));
    const binary = join(dir, id === "windows-x64" ? "multi-call-binary.exe" : "multi-call-binary");
    // Records each call when CALLS names a file, so a test can see what the launcher ran.
    writeFileSync(binary, `#!/bin/sh\n[ -n "$CALLS" ] && echo "$@" >> "$CALLS"\necho "${id} $@"\n`);
    chmodSync(binary, 0o755);
  }
  return { base, launcher, installScript };
}

function render(input: {
  readonly completionCommands: ReadonlyArray<string>;
  readonly daemons: ReadonlyArray<string>;
  readonly isInstallScript: boolean;
}): string {
  const map = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-arm64": "linux-arm64", "linux-x64": "linux-x64", "win32-x64": "windows-x64" };
  return ejs.render(COMMAND_LAUNCHER_TEMPLATE, {
    commandNames: ["demo", ...input.daemons],
    completionCommands: input.completionCommands,
    completionSkipFlags: ["--compgen", "--completion", "--setup-completion"],
    setUpMissingCompletionFlag: "--setup-completion-if-missing",
    packageName: PKG,
    daemons: input.daemons,
    daemonIdPrefix: "test",
    daemonHomeDir: DAEMON_HOME_DIR,
    daemonRegistrySubdir: DAEMON_REGISTRY_SUBDIR,
    daemonLogSubdir: DAEMON_LOG_SUBDIR,
    repairOnlyFlag: "--repair-only",
    binDir: "bin",
    isInstallScript: input.isInstallScript,
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
    const result = run(install({ platforms: [other] }).launcher);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`${other} hello`);
  });

  test("uses the installed package that matches Node when there are several", () => {
    const result = run(install({ platforms: [other, reported] }).launcher);
    expect(result.stdout.trim()).toBe(`${reported} hello`);
  });

  test("names every platform package when none is installed", () => {
    const result = run(install({ platforms: [] }).launcher);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`None of ${PKG}'s platform packages is installed`);
    expect(result.stderr).toContain(`${PKG}-darwin-arm64`);
  });

  test("refuses to guess between several when none matches Node", () => {
    const others = PLATFORMS.filter((id) => id !== reported && id !== "windows-x64").slice(0, 2);
    const result = run(install({ platforms: others }).launcher);
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
    const result = spawnSync("node", [install({ platforms: [reported], completionCommands }).launcher, ...args], {
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

/**
 * Fake service managers first on PATH, and nothing but HOME and PATH in the environment, so no install here reaches
 * the real launchd or systemd: even a real `systemctl --user` would find no session bus. Each fake records its call,
 * and when asked to start a unit, copies the daemon records as they are at that moment.
 */
function scratchHome() {
  const home = mkdtempSync(join(tmpdir(), "installer-home-"));
  const fakeBin = join(home, "fake-bin");
  mkdirSync(fakeBin);
  for (const command of ["launchctl", "systemctl", "loginctl"]) {
    writeFileSync(join(fakeBin, command), [
      "#!/bin/sh",
      `echo "${command} $*" >> "$HOME/service-manager-calls"`,
      `case "$*" in *bootstrap*|*restart*) cat "$HOME"/.jive/daemons/*.json > "$HOME/records-when-started";; esac`,
      "exit 0",
    ].join("\n"));
    chmodSync(join(fakeBin, command), 0o755);
  }
  const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim();
  const searchPath = [fakeBin, dirname(node), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
  return { home, env: { HOME: home, PATH: searchPath } };
}

const SERVICE_MANAGER_KIND: Record<string, string> = { darwin: "launchd", linux: "systemd" };

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("install.cjs run again by a later install", () => {
  test("runs every time, stays in place, and replaces its daemon's registration", () => {
    const { base, installScript } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { home, env } = scratchHome();
    const runs = [1, 2].map(() => spawnSync("node", [installScript], { encoding: "utf8", env }));

    expect(runs.map((result) => ({ status: result.status, stderr: result.stderr })))
      .toEqual([{ status: 0, stderr: "" }, { status: 0, stderr: "" }]);
    expect(runs[0]!.stdout).toContain("Creating daemon test.test.demo.demo-daemon.");
    expect(runs[1]!.stdout).toContain("Replacing existing daemon test.test.demo.demo-daemon.");
    expect(existsSync(installScript)).toBe(true);
    expect(spawnSync(join(base, "bin", "demo"), ["hello"], { encoding: "utf8" }).stdout.trim()).toBe(`${reported} hello`);
    expect(readdirSync(join(home, DAEMON_HOME_DIR, DAEMON_REGISTRY_SUBDIR)).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
  });

  test("has written the whole daemon record, kind and unit included, by the time the unit starts", () => {
    const { installScript } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { home, env } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);

    const recordWhenStarted = JSON.parse(readFileSync(join(home, "records-when-started"), "utf8"));
    expect(recordWhenStarted).toMatchObject({
      name: "demo-daemon",
      packageName: PKG,
      kind: SERVICE_MANAGER_KIND[process.platform],
      unit: expect.stringContaining("test.test.demo.demo-daemon."),
      logPath: expect.stringContaining(join(home, DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR)),
    });
  });
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("a bun global install from a local folder", () => {
  /**
   * The setup agenticloud-connect runs: `bun add -g --trust <checkout>/dist/base`, whose postinstall is
   * `node ./install.cjs`, then any other global install, which may rerun that trusted postinstall.
   */
  test("leaves later global installs of other packages working", () => {
    const { base } = install({ platforms: [reported] });
    const { home, env } = scratchHome();
    writeFileSync(join(base, "package.json"), JSON.stringify({
      name: PKG,
      version: "1.0.0",
      type: "module",
      bin: { demo: "./bin/demo" },
      scripts: { postinstall: "node ./install.cjs" },
      dependencies: { [`${PKG}-${reported}`]: `file:${join(dirname(base), `demo-${reported}`)}` },
    }));
    const other = join(home, "other");
    mkdirSync(other);
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@test/other", version: "1.0.0" }));
    const bunEnv = { ...env, BUN_INSTALL: join(home, ".bun") };
    const bunAdd = (...args: Array<string>) => spawnSync(process.execPath, ["add", "-g", ...args], { encoding: "utf8", env: bunEnv });

    const first = bunAdd("--trust", base);
    expect({ status: first.status, stderr: first.stderr }).toMatchObject({ status: 0 });
    const installed = join(home, ".bun", "install", "global", "node_modules", PKG);
    expect(existsSync(join(installed, "install.cjs"))).toBe(true);

    const second = bunAdd(other);
    expect({ status: second.status, stderr: second.stderr }).toMatchObject({ status: 0 });
    expect(existsSync(join(installed, "install.cjs"))).toBe(true);
  }, 60_000);
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("repairing a half-written daemon record", () => {
  /**
   * A registration made by this install.cjs, then cut back to what jive-abstract-library 0.14.1 and earlier left
   * when an install stopped after writing the record and before registering: no kind, unit or logPath.
   */
  test("reruns the package's install.cjs, which rewrites the record whole, and lists it", async () => {
    const { installScript } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { home, env } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);
    const registry = join(home, DAEMON_HOME_DIR, DAEMON_REGISTRY_SUBDIR);
    const [recordFile] = readdirSync(registry).filter((entry) => entry.endsWith(".json"));
    const recordPath = join(registry, recordFile!);
    const { kind: _kind, unit: _unit, logPath: _logPath, ...half } = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify(half));

    const logs: Array<string> = [];
    // Runs each process for real, but with the scratch HOME and the fake service managers.
    const osPlatform = OSPlatformImpl.mockLayer({
      *getHomeDirectory() { return home; },
      *spawnProcess(spawn: SpawnProcessInput) {
        const result = spawnSync(spawn.command, [...(spawn.args ?? [])], { cwd: spawn.cwd, encoding: "utf8", env });
        return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    });
    const listed = await Effect.runPromise(pipe(
      effunct(function* () {
        const daemon = yield* libraryModules.Daemon;
        yield* daemon.repairBrokenRecords();
        return yield* daemon.list();
      })(),
      Effect.provide(pipe(DaemonImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer))),
      Effect.provide(Logger.layer([Logger.make(({ message }) => { logs.push(String(message)); })])),
    ));

    expect(listed).toEqual([expect.objectContaining({
      id: half.id,
      kind: SERVICE_MANAGER_KIND[process.platform],
      unit: expect.stringContaining(half.id),
      logPath: join(home, DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR, `${half.id}.log`),
    })]);
    expect(logs).toEqual([`Repaired ${recordPath} by running node ${installScript}`]);
  });
});
