import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Layer, Logger, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct } from "effective-modules";
import { libraryModules } from "../modules";
import { PLATFORMS } from "../modules/builder/interface";
import { DaemonImpl } from "../modules/daemon/impl";
import { OSPlatformImpl } from "../modules/os-platform/impl";
import type { SpawnProcessInput } from "../modules/os-platform/interface";
import {
  BIN_DIR,
  DAEMON_HOME_DIR,
  DAEMON_ID_PREFIX,
  DAEMON_LOG_SUBDIR,
  DAEMON_REGISTRY_SUBDIR,
  MULTI_CALL_BINARY,
  POSTINSTALL_SCRIPT,
  REPAIR_ONLY_FLAG,
  WINDOWS_EXECUTABLE_SUFFIX,
} from "./constants";
import { COMMAND_LAUNCHER_SOURCE, POSTINSTALL_SOURCE } from "./postinstall-script";
import { COMPGEN_FLAG, COMPLETION_SCRIPT_FLAG, SET_UP_COMPLETION_FLAG, SET_UP_MISSING_COMPLETION_FLAG } from "../public/cli/parse";

const PKG = "@test/demo";
type PlatformId = (typeof PLATFORMS)[number]["id"];

/** The platform id that `node`, as run by these tests, reports. */
const reported = (() => {
  const result = spawnSync("node", ["-p", "process.platform + '-' + process.arch"], { encoding: "utf8" });
  return PLATFORMS.find((platform) => `${platform.os}-${platform.cpu}` === result.stdout.trim())!.id;
})();
const other = PLATFORMS.find((platform) => platform.id !== reported)!.id;

/**
 * A global install the way a package manager lays out a package the builder made: postinstall.cjs at the base package's
 * root, the launcher as each command in `bin/`, a package.json naming the commands in "bin", the platform packages in
 * "optionalDependencies" and the daemons and completion commands in "jive", and beside it the platform packages the
 * manager chose to install. Each platform's program is a shell script that says which platform package it came from and
 * which command it was run as, and records each call when CALLS names a file.
 */
function install(input: {
  readonly platforms: ReadonlyArray<PlatformId>;
  readonly commands?: ReadonlyArray<string>;
  readonly completionCommands?: ReadonlyArray<string>;
  readonly daemons?: ReadonlyArray<string>;
}) {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "postinstall-test-"))), "node_modules");
  const base = join(root, PKG);
  const daemons = input.daemons ?? [];
  const commands = [...(input.commands ?? ["demo"]), ...daemons];
  mkdirSync(join(base, BIN_DIR), { recursive: true });
  writeFileSync(join(base, "package.json"), JSON.stringify({
    name: PKG,
    version: "1.0.0",
    type: "module",
    scripts: { postinstall: `node ./${POSTINSTALL_SCRIPT}` },
    bin: Object.fromEntries(commands.map((command) => [command, `./${BIN_DIR}/${command}`])),
    optionalDependencies: Object.fromEntries(PLATFORMS.map((platform) => [`${PKG}-${platform.id}`, `1.0.0-${platform.id}`])),
    jive: { daemons, completionCommands: input.completionCommands ?? [] },
  }));
  writeFileSync(join(base, BIN_DIR, "package.json"), JSON.stringify({ type: "commonjs" }));
  for (const command of commands) {
    writeFileSync(join(base, BIN_DIR, command), COMMAND_LAUNCHER_SOURCE);
    chmodSync(join(base, BIN_DIR, command), 0o755);
  }
  const installScript = join(base, POSTINSTALL_SCRIPT);
  writeFileSync(installScript, POSTINSTALL_SOURCE);
  const binaries: Partial<Record<PlatformId, string>> = {};
  for (const id of input.platforms) {
    const platform = PLATFORMS.find((candidate) => candidate.id === id)!;
    const dir = join(root, `${PKG}-${id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: PKG, version: `1.0.0-${id}`, os: [platform.os], cpu: [platform.cpu] }));
    const binary = join(dir, platform.os === "win32" ? `${MULTI_CALL_BINARY}${WINDOWS_EXECUTABLE_SUFFIX}` : MULTI_CALL_BINARY);
    writeFileSync(binary, `#!/bin/sh\n[ -n "$CALLS" ] && echo "$(basename "$0") $@" >> "$CALLS"\necho "${id} $@"\n`);
    chmodSync(binary, 0o755);
    binaries[id] = binary;
  }
  return { base, installScript, binaries, launcher: (command: string) => join(base, BIN_DIR, command) };
}

/**
 * Fake service managers first on PATH, and nothing but HOME, PATH and CALLS in the environment, so nothing here reaches
 * the real launchd or systemd (even a real `systemctl --user` would find no session bus) or the real home folder. Each
 * fake records its call, and when asked to start a unit, copies the daemon records as they are at that moment.
 */
function scratchHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "postinstall-home-")));
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
  const calls = join(home, "calls");
  return {
    home,
    env: { HOME: home, PATH: searchPath, CALLS: calls },
    calls: () => existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [],
    serviceManagerCalls: () => existsSync(join(home, "service-manager-calls"))
      ? readFileSync(join(home, "service-manager-calls"), "utf-8").trim().split("\n")
      : [],
    records: () => {
      const registry = join(home, DAEMON_HOME_DIR, DAEMON_REGISTRY_SUBDIR);
      return existsSync(registry) ? readdirSync(registry).filter((entry) => entry.endsWith(".json")).map((entry) => join(registry, entry)) : [];
    },
  };
}

const SERVICE_MANAGER_KIND: Record<string, string> = { darwin: "launchd", linux: "systemd" };
const sameFile = (a: string, b: string) => statSync(a).ino === statSync(b).ino && statSync(a).dev === statSync(b).dev;

describe.skipIf(process.platform === "win32")("choosing the platform package", () => {
  const run = (launcher: string) => spawnSync("node", [launcher, "hello"], { encoding: "utf8", env: scratchHome().env });

  test("uses the one installed platform package, even when it is not the one Node reports", () => {
    // Panda: bun (native arm64) installed darwin-arm64, and the launcher ran under Node reporting "x64".
    const result = run(install({ platforms: [other] }).launcher("demo"));
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(`${other} hello`);
  });

  test("uses the installed package whose os and cpu match Node when there are several", () => {
    const result = run(install({ platforms: [other, reported] }).launcher("demo"));
    expect(result.stdout.trim()).toBe(`${reported} hello`);
  });

  test("names every platform package in optionalDependencies when none is installed", () => {
    const result = run(install({ platforms: [] }).launcher("demo"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`None of ${PKG}'s platform packages is installed`);
    expect(result.stderr).toContain(`${PKG}-darwin-arm64`);
    expect(result.stderr).toContain(`${PKG}-windows-x64`);
  });

  test("refuses to guess between several when none matches Node", () => {
    const others = PLATFORMS.filter((platform) => platform.id !== reported && platform.os !== "win32").slice(0, 2).map((platform) => platform.id);
    const result = run(install({ platforms: others }).launcher("demo"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Several of ${PKG}'s platform packages are installed`);
  });
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("postinstall.cjs", () => {
  test("replaces every command in bin with a hard link to the platform package's program", () => {
    const { installScript, binaries, launcher } = install({ platforms: [reported], commands: ["demo", "other"], daemons: ["demo-daemon"] });
    const { env } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);

    for (const command of ["demo", "other", "demo-daemon"]) {
      expect(sameFile(launcher(command), binaries[reported]!)).toBe(true);
    }
    // Run directly, as a shell would: the program itself answers, under the command's own name.
    expect(spawnSync(launcher("other"), ["hello"], { encoding: "utf8" }).stdout.trim()).toBe(`${reported} hello`);
  });

  test("registers each daemon its package.json's jive field lists, under the scratch HOME, and asks only its completion commands to set up completion", () => {
    const { base, installScript, launcher } = install({
      platforms: [reported],
      commands: ["demo", "other"],
      completionCommands: ["other"],
      daemons: ["demo-daemon"],
    });
    const { home, env, calls, records, serviceManagerCalls } = scratchHome();
    const result = spawnSync("node", [installScript], { encoding: "utf8", env });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(calls()).toEqual([`other ${SET_UP_MISSING_COMPLETION_FLAG}`]);
    expect(records()).toHaveLength(1);
    const record = JSON.parse(readFileSync(records()[0]!, "utf8"));
    expect(record).toMatchObject({
      name: "demo-daemon",
      packageName: PKG,
      packageDir: base,
      executable: launcher("demo-daemon"),
      kind: SERVICE_MANAGER_KIND[process.platform],
      logPath: join(home, DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR, `${record.id}.log`),
    });
    expect(record.id).toStartWith(`${DAEMON_ID_PREFIX}.test.demo.demo-daemon.`);
    expect(serviceManagerCalls().some((call) => call.includes(record.unit))).toBe(true);
  });

  /**
   * postinstall.cjs and the library's TypeScript each define the folders under the home folder, the daemon id prefix and
   * the command folder. This is where they must agree: the library's public `daemonStatuses`, run in its own process with
   * the same scratch HOME, lists the daemon postinstall.cjs registered.
   */
  test("the library's daemon listing finds the daemon postinstall.cjs registered, with its log where the library expects", () => {
    const { base, installScript, launcher } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { home, env } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);

    const library = join(import.meta.dir, "..", "public", "daemon.ts");
    const listing = spawnSync(process.execPath, ["-e", `import { Effect } from "effect";
      import { daemonStatuses } from ${JSON.stringify(library)};
      const statuses = await Effect.runPromise(daemonStatuses);
      console.log(JSON.stringify(statuses.map(({ registration }) => registration)));`], { encoding: "utf8", env, cwd: import.meta.dir });
    expect({ status: listing.status, stderr: listing.stderr }).toEqual({ status: 0, stderr: "" });

    const registrations = JSON.parse(listing.stdout);
    expect(registrations).toHaveLength(1);
    const [registration] = registrations;
    expect(registration).toMatchObject({
      name: "demo-daemon",
      packageName: PKG,
      packageDir: base,
      executable: launcher("demo-daemon"),
      kind: SERVICE_MANAGER_KIND[process.platform],
      logPath: join(home, DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR, `${registration.id}.log`),
    });
    expect(registration.id).toStartWith(`${DAEMON_ID_PREFIX}.test.demo.demo-daemon.`);
  });

  test("runs every time, stays in place, and replaces its daemon's registration", () => {
    const { installScript, launcher } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { env, records } = scratchHome();
    const runs = [1, 2].map(() => spawnSync("node", [installScript], { encoding: "utf8", env }));

    expect(runs.map((result) => ({ status: result.status, stderr: result.stderr })))
      .toEqual([{ status: 0, stderr: "" }, { status: 0, stderr: "" }]);
    expect(runs[0]!.stdout).toContain(`Creating daemon ${DAEMON_ID_PREFIX}.test.demo.demo-daemon.`);
    expect(runs[1]!.stdout).toContain(`Replacing existing daemon ${DAEMON_ID_PREFIX}.test.demo.demo-daemon.`);
    expect(existsSync(installScript)).toBe(true);
    expect(spawnSync(launcher("demo"), ["hello"], { encoding: "utf8" }).stdout.trim()).toBe(`${reported} hello`);
    expect(records()).toHaveLength(1);
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
      unit: expect.stringContaining(`${DAEMON_ID_PREFIX}.test.demo.demo-daemon.`),
      logPath: expect.stringContaining(join(home, DAEMON_HOME_DIR, DAEMON_LOG_SUBDIR)),
    });
  });

  test(`with ${REPAIR_ONLY_FLAG}, links the commands, registers nothing and removes this copy's earlier registration`, () => {
    const { installScript, binaries, launcher } = install({ platforms: [reported], completionCommands: ["demo"], daemons: ["demo-daemon"] });
    const { env, calls, records } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);
    expect(records()).toHaveLength(1);

    const repair = spawnSync("node", [installScript, REPAIR_ONLY_FLAG], { encoding: "utf8", env });
    expect(repair.status).toBe(0);
    expect(repair.stdout).toContain(`${REPAIR_ONLY_FLAG} was passed: not registering demo-daemon`);
    expect(records()).toEqual([]);
    expect(sameFile(launcher("demo"), binaries[reported]!)).toBe(true);
    // Completion was set up by the first run only.
    expect(calls()).toEqual([`demo ${SET_UP_MISSING_COMPLETION_FLAG}`]);
  });
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("a command's first run, when the package manager skipped postinstall.cjs", () => {
  test("sets the package up as postinstall.cjs would, then runs what was typed", () => {
    const { binaries, launcher } = install({ platforms: [reported], commands: ["demo", "other"], completionCommands: ["demo"], daemons: ["demo-daemon"] });
    const { env, calls, records } = scratchHome();
    const result = spawnSync("node", [launcher("other"), "hello"], { encoding: "utf8", env });

    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    // The command's own stdout reaches the caller; what completion setup printed does not.
    expect(result.stdout.trim().split("\n").at(-1)).toBe(`${reported} hello`);
    expect(calls()).toEqual([`demo ${SET_UP_MISSING_COMPLETION_FLAG}`, "other hello"]);
    for (const command of ["demo", "other", "demo-daemon"]) {
      expect(sameFile(launcher(command), binaries[reported]!)).toBe(true);
    }
    expect(records()).toHaveLength(1);
  });

  test("leaves completion alone for a shell's or launcher's own call, and for a command not built with Cli", () => {
    const launch = (completionCommands: ReadonlyArray<string>, ...args: Array<string>) => {
      const { env, calls } = scratchHome();
      spawnSync("node", [install({ platforms: [reported], completionCommands }).launcher("demo"), ...args], { encoding: "utf8", env });
      return calls();
    };
    expect(launch(["demo"], COMPGEN_FLAG, "")).toEqual([`demo ${COMPGEN_FLAG}`]);
    expect(launch(["demo"], COMPLETION_SCRIPT_FLAG, "zsh")).toEqual([`demo ${COMPLETION_SCRIPT_FLAG} zsh`]);
    expect(launch(["demo"], SET_UP_COMPLETION_FLAG)).toEqual([`demo ${SET_UP_COMPLETION_FLAG}`]);
    expect(launch([], "hello")).toEqual(["demo hello"]);
  });

  test("passes the program's exit status on", () => {
    const { launcher, binaries } = install({ platforms: [reported] });
    writeFileSync(binaries[reported]!, "#!/bin/sh\nexit 7\n");
    expect(spawnSync("node", [launcher("demo")], { encoding: "utf8", env: scratchHome().env }).status).toBe(7);
  });
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("a bun global install from a local folder", () => {
  /**
   * The setup agenticloud-connect runs: `bun add -g --trust <checkout>/dist/base`, whose postinstall is
   * `node ./postinstall.cjs`, then any other global install, which may rerun that trusted postinstall.
   */
  test("leaves later global installs of other packages working", () => {
    const { base, binaries } = install({ platforms: [reported] });
    const { home, env } = scratchHome();
    const manifest = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
    manifest.optionalDependencies = { [`${PKG}-${reported}`]: `file:${dirname(binaries[reported]!)}` };
    writeFileSync(join(base, "package.json"), JSON.stringify(manifest));
    const other = join(home, "other");
    mkdirSync(other);
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "@test/other", version: "1.0.0" }));
    const bunEnv = { ...env, BUN_INSTALL: join(home, ".bun") };
    const bunAdd = (...args: Array<string>) => spawnSync(process.execPath, ["add", "-g", ...args], { encoding: "utf8", env: bunEnv });

    const first = bunAdd("--trust", base);
    expect({ status: first.status, stderr: first.stderr }).toMatchObject({ status: 0 });
    const installed = join(home, ".bun", "install", "global", "node_modules", PKG);
    expect(existsSync(join(installed, POSTINSTALL_SCRIPT))).toBe(true);

    const second = bunAdd(other);
    expect({ status: second.status, stderr: second.stderr }).toMatchObject({ status: 0 });
    expect(existsSync(join(installed, POSTINSTALL_SCRIPT))).toBe(true);
  }, 60_000);
});

describe.skipIf(!(process.platform in SERVICE_MANAGER_KIND))("repairing a half-written daemon record", () => {
  /**
   * A registration made by postinstall.cjs, then cut back to what jive-abstract-library 0.14.1 and earlier left when an
   * install stopped after writing the record and before registering: no kind, unit or logPath.
   */
  test("deletes it, runs nothing, and warns that the package that wrote it must be reinstalled", async () => {
    const { base, installScript } = install({ platforms: [reported], daemons: ["demo-daemon"] });
    const { home, env, records } = scratchHome();
    expect(spawnSync("node", [installScript], { encoding: "utf8", env }).status).toBe(0);
    const [recordPath] = records();
    const { kind: _kind, unit: _unit, logPath: _logPath, ...half } = JSON.parse(readFileSync(recordPath!, "utf8"));
    writeFileSync(recordPath!, JSON.stringify(half));

    const logs: Array<{ readonly level: string; readonly message: string }> = [];
    const spawned: Array<string> = [];
    const osPlatform = OSPlatformImpl.mockLayer({
      *getHomeDirectory() { return home; },
      *spawnProcess(spawn: SpawnProcessInput) {
        spawned.push([spawn.command, ...(spawn.args ?? [])].join(" "));
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const listed = await Effect.runPromise(pipe(
      effunct(function* () {
        const daemon = yield* libraryModules.Daemon;
        yield* daemon.repairBrokenRecords();
        return yield* daemon.list();
      })(),
      Effect.provide(pipe(DaemonImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer))),
      Effect.provide(Logger.layer([Logger.make(({ logLevel, message }) => { logs.push({ level: logLevel, message: String(message) }); })])),
    ));

    expect(listed).toEqual([]);
    expect(records()).toEqual([]);
    expect(spawned).toEqual([]);
    expect(logs).toEqual([{
      level: "Warn",
      message: `Removed ${recordPath}: it was not a complete daemon registration. Reinstall ${PKG} (installed at ${base}) to register its daemon again.`,
    }]);
  });
});
