import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Logger, Option, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import type { SpawnProcessInput } from "../os-platform/interface";
import { DaemonImpl } from "./impl";
import type { DaemonRegistration } from "./interface";

const COMPLETE: DaemonRegistration = {
  id: "jive-daemon.test.demo.watcher.0123456789",
  name: "watcher",
  packageName: "@test/demo",
  packageDir: "/home/me/.bun/install/global/node_modules/@test/demo",
  workingDirectory: "/home/me/.bun/install/global",
  kind: "systemd",
  unit: "jive-daemon.test.demo.watcher.0123456789.service",
  logPath: "/home/me/.jive/logs/jive-daemon.test.demo.watcher.0123456789.log",
  executable: "/home/me/.bun/install/global/node_modules/@test/demo/bin/watcher",
  registeredAt: "2026-11-20T00:00:00.000Z",
  searchPath: "/usr/bin:/bin",
  files: ["/home/me/.config/systemd/user/jive-daemon.test.demo.watcher.0123456789.service"],
  unregister: ["systemctl", "--user", "disable", "--now", "jive-daemon.test.demo.watcher.0123456789.service"],
};

/**
 * The record jive-abstract-library 0.14.1 and earlier wrote before registering a daemon, and left behind when the
 * install stopped there: every field but kind, unit and logPath.
 */
function halfRecord(input: { readonly name: string; readonly packageDir: string }) {
  const id = `jive-daemon._.other.${input.name}.9876543210`;
  return {
    id,
    name: input.name,
    packageName: "other",
    packageDir: input.packageDir,
    workingDirectory: input.packageDir,
    executable: join(input.packageDir, "bin", input.name),
    registeredAt: "2026-11-19T00:00:00.000Z",
    searchPath: "/usr/bin:/bin",
    files: [`/home/me/.jive/daemons/${id}.json`],
    unregister: [],
  };
}

/**
 * Repairs then lists a registry holding `records` (file name to contents) the way `jive daemons` does
 * (`repairDaemonRecords`, then `daemonStatuses`), with every process answered by `spawn`. Returns each status, every
 * process started, every log line and the registry folder.
 */
async function statuses(input: {
  readonly records: (home: string) => Record<string, string>;
  readonly spawn?: (spawn: SpawnProcessInput) => { exitCode: number; stdout: string; stderr: string };
}) {
  const home = mkdtempSync(join(tmpdir(), "daemon-registry-"));
  const registry = join(home, ".jive", "daemons");
  mkdirSync(registry, { recursive: true });
  for (const [file, text] of Object.entries(input.records(home))) writeFileSync(join(registry, file), text);

  const calls: Array<string> = [];
  const logs: Array<string> = [];
  const osPlatform = OSPlatformImpl.mockLayer({
    *getHomeDirectory() { return home; },
    *spawnProcess(spawn: SpawnProcessInput) {
      calls.push([spawn.command, ...(spawn.args ?? [])].join(" "));
      return input.spawn !== undefined ? input.spawn(spawn) : { exitCode: 0, stdout: "ActiveState=active\nMainPID=4242\n", stderr: "" };
    },
  });
  const result = await Effect.runPromise(pipe(
    effunct(function* () {
      const daemon = yield* libraryModules.Daemon;
      yield* daemon.repairBrokenRecords();
      const found = [];
      for (const registration of yield* daemon.list()) found.push(yield* daemon.status(registration));
      return found;
    })(),
    Effect.provide(pipe(DaemonImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer))),
    Effect.provide(Logger.layer([Logger.make(({ message }) => { logs.push(String(message)); })])),
  ));
  return { result, calls, logs, home, registry };
}

/** A package directory under `home`, with an install.cjs when `withInstaller`. */
function packageDirIn(input: { readonly home: string; readonly withInstaller: boolean }): string {
  const packageDir = join(input.home, "node_modules", "other");
  mkdirSync(packageDir, { recursive: true });
  if (input.withInstaller) writeFileSync(join(packageDir, "install.cjs"), "");
  return packageDir;
}

describe("listing daemons", () => {
  test("reports every complete registration and skips, by path, one it cannot repair", async () => {
    const { result, calls, logs, registry } = await statuses({
      records: (home) => ({
        "a.json": JSON.stringify(COMPLETE),
        "b.json": JSON.stringify(halfRecord({ name: "agent", packageDir: packageDirIn({ home, withInstaller: false }) })),
      }),
    });

    expect(result).toEqual([{ registration: COMPLETE, state: "running", pid: Option.some(4242), executableExists: false }]);
    expect(calls).toEqual([`systemctl --user show --property=ActiveState --property=MainPID ${COMPLETE.unit}`]);
    expect(existsSync(join(registry, "b.json"))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith(`Skipping ${join(registry, "b.json")}: it is not a complete daemon registration (`);
    expect(logs[0]).toContain(`"kind"`);
    expect(logs[0]).toEndWith("Reinstalling the package that registered it rewrites it.");
  });

  test("skips a record that is not JSON and still reports the rest", async () => {
    const { result, logs, registry } = await statuses({ records: () => ({ "a.json": "{\"id\": ", "b.json": JSON.stringify(COMPLETE) }) });

    expect(result.map(({ registration }) => registration.id)).toEqual([COMPLETE.id]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toStartWith(`Skipping ${join(registry, "a.json")}: it is not a complete daemon registration (`);
  });
});

describe("repairing broken daemon records", () => {
  test("deletes a half record whose package directory is gone", async () => {
    const { result, calls, logs, home, registry } = await statuses({
      records: (home) => ({ "a.json": JSON.stringify(halfRecord({ name: "agent", packageDir: join(home, "node_modules", "removed") })) }),
    });

    expect(result).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(join(registry, "a.json"))).toBe(false);
    expect(logs).toEqual([`Removed ${join(registry, "a.json")}: the package it registered, ${join(home, "node_modules", "removed")}, is gone`]);
  });

  test("runs a package's install.cjs once for all of its broken records", async () => {
    const { calls, logs, home, registry } = await statuses({
      records: (home) => {
        const packageDir = packageDirIn({ home, withInstaller: true });
        return {
          "a.json": JSON.stringify(halfRecord({ name: "agent", packageDir })),
          "b.json": JSON.stringify(halfRecord({ name: "watcher", packageDir })),
        };
      },
      // An installer that runs but leaves the records as they were.
      spawn: () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    expect(calls).toEqual([`node ${join(home, "node_modules", "other", "install.cjs")}`]);
    expect(logs.map((line) => line.split(":")[0])).toEqual([`Skipping ${join(registry, "a.json")}`, `Skipping ${join(registry, "b.json")}`]);
  });

  test("skips, naming why, a record whose package's install.cjs fails", async () => {
    const { logs, home, registry } = await statuses({
      records: (home) => ({ "a.json": JSON.stringify(halfRecord({ name: "agent", packageDir: packageDirIn({ home, withInstaller: true }) })) }),
      spawn: () => ({ exitCode: 1, stdout: "", stderr: "Cannot find module 'fs'" }),
    });

    expect(logs).toEqual([
      `Could not repair ${join(registry, "a.json")}: node ${join(home, "node_modules", "other", "install.cjs")} failed (exit code 1: Cannot find module 'fs')`,
      expect.stringContaining(`Skipping ${join(registry, "a.json")}: it is not a complete daemon registration (`),
    ]);
  });
});
