import { Effect, FileSystem, Option, Result, Schema, SchemaIssue, pipe } from "effect";
import { effunct, implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { DAEMON_HOME_DIR, DAEMON_REGISTRY_SUBDIR, INSTALL_SCRIPT } from "../../common/constants";
import { discoverDaemonNames } from "../../public/daemons";
import { libraryModules } from "../index";
import type { IOSPlatform } from "../os-platform/interface";
import type { DaemonRegistration, DaemonStatus, IDaemon } from "./interface";

export class DaemonImpl extends implementing(libraryModules.Daemon)
  .uses(libraryModules.OSPlatform, FileSystem.FileSystem)
  implements IDaemon {

  *discoverNames(rootDir: string): EffectGen<ReadonlyArray<string>, string> {
    return yield* Effect.provideService(
      discoverDaemonNames(rootDir),
      FileSystem.FileSystem,
      this.getDependency(FileSystem.FileSystem),
    );
  }

  /**
   * The registration this process is running under, found by its own executable.
   *
   * The unit file used to hand the daemon its id in an environment variable. It does not need to: the
   * registration records the executable it points at, a compiled binary knows its own path, and that path
   * is what the id was derived from in the first place. One fewer contract, and it works the same when a
   * daemon is started by hand rather than by the service manager.
   */
  *currentRegistration(): EffectGen<Option.Option<DaemonRegistration>, string> {
    const self = yield* this.dependencies.OSPlatform.getExecutablePath();
    // Compared against the real path as well, since a copy installed through a symlinked tree resolves to
    // somewhere other than the path the installer wrote down.
    const selfReal = yield* this.realPathOr(self);

    return Option.fromUndefinedOr(
      (yield* this.list()).find((registration) =>
        registration.executable === self || registration.executable === selfReal),
    );
  }

  private *realPathOr(path: string): EffectGen<string, string> {
    const result = yield* Effect.result(this.getDependency(FileSystem.FileSystem).realPath(path));
    return result._tag === "Success" ? result.success : path;
  }

  *list(): EffectGen<ReadonlyArray<DaemonRegistration>, string> {
    const registrations: DaemonRegistration[] = [];
    for (const { path, text } of yield* this.readRecords()) {
      // One bad record must not hide every other daemon: a half-written file, or one an install stopped before
      // finishing (older installers wrote the record once without its kind and unit, then again with them), is a
      // thing to report, not a reason to answer "no daemons" or to fail every caller.
      const decoded = Schema.decodeUnknownResult(RecordedRegistration)(text);
      if (Result.isFailure(decoded)) {
        yield* Effect.logWarning(
          `Skipping ${path}: it is not a complete daemon registration (${formatIssue(decoded.failure.issue)}). `
          + "Reinstalling the package that registered it rewrites it.",
        );
        continue;
      }
      registrations.push(decoded.success);
    }
    return registrations;
  }

  *repairBrokenRecords(): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    // Whether each package directory's installer ran and succeeded this time, so a package with several broken
    // records is reinstalled once.
    const installerSucceeded = new Map<string, boolean>();
    const rewritten: Array<{ readonly path: string; readonly installScript: string }> = [];

    for (const { path, text } of yield* this.readRecords()) {
      if (Result.isSuccess(Schema.decodeUnknownResult(RecordedRegistration)(text))) continue;
      const maybeRecorded = Schema.decodeUnknownOption(RecordedPackageDir)(text);
      if (Option.isNone(maybeRecorded)) continue;
      const { packageDir } = maybeRecorded.value;

      // The installer prunes a record whose package directory is gone for the same reason: nothing is left to start.
      if (!(yield* this.fsOp(fs.exists(packageDir)))) {
        yield* this.fsOp(fs.remove(path, { force: true }));
        yield* Effect.log(`Removed ${path}: the package it registered, ${packageDir}, is gone`);
        continue;
      }
      const installScript = resolve(packageDir, INSTALL_SCRIPT);
      if (!(yield* this.fsOp(fs.exists(installScript)))) continue;

      if (!installerSucceeded.has(packageDir)) {
        // Without the repair-only flag, so the installer registers this copy's daemons again and writes their
        // records whole.
        const result = yield* Effect.result(effunct(this.dependencies.OSPlatform.spawnProcess.bind(this.dependencies.OSPlatform))({
          command: "node",
          args: [installScript],
          cwd: packageDir,
        }));
        const failure = Result.isFailure(result) ? result.failure
          : result.success.exitCode !== 0 ? `exit code ${result.success.exitCode}: ${result.success.stderr.trim()}`
          : undefined;
        installerSucceeded.set(packageDir, failure === undefined);
        if (failure !== undefined) {
          yield* Effect.logWarning(`Could not repair ${path}: node ${installScript} failed (${failure})`);
        }
      }
      if (installerSucceeded.get(packageDir) === true) rewritten.push({ path, installScript });
    }

    for (const { path, installScript } of rewritten) {
      if (!(yield* this.fsOp(fs.exists(path)))) {
        yield* Effect.log(`Removed ${path}: node ${installScript} no longer registers it`);
        continue;
      }
      if (Result.isSuccess(Schema.decodeUnknownResult(RecordedRegistration)(yield* this.fsOp(fs.readFileString(path))))) {
        yield* Effect.log(`Repaired ${path} by running node ${installScript}`);
      }
    }
  }

  /** Every `.json` record in the registry, sorted by file name, as text. */
  private *readRecords(): EffectGen<ReadonlyArray<{ readonly path: string; readonly text: string }>, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const dir = yield* this.registryDir();
    if (!(yield* this.fsOp(fs.exists(dir)))) return [];

    const records: Array<{ readonly path: string; readonly text: string }> = [];
    for (const child of [...(yield* this.fsOp(fs.readDirectory(dir)))].sort()) {
      if (!child.endsWith(".json")) continue;
      const path = resolve(dir, child);
      records.push({ path, text: yield* this.fsOp(fs.readFileString(path)) });
    }
    return records;
  }

  *status(registration: DaemonRegistration): EffectGen<DaemonStatus, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const executableExists = yield* this.fsOp(fs.exists(registration.executable));
    const probe = STATUS_PROBES[registration.kind];
    const result = yield* Effect.result(
      effunct(this.dependencies.OSPlatform.spawnProcess.bind(this.dependencies.OSPlatform))(probe.command(registration)),
    );

    if (result._tag === "Failure" || result.success.exitCode !== 0) {
      // The service manager does not know the unit. Either it never loaded, or something removed it
      // behind the registry's back.
      return { registration, state: "stopped", pid: Option.none(), executableExists };
    }
    const { state, pid } = probe.read(result.success.stdout);
    return { registration, state, pid, executableExists };
  }

  *deregister(registration: DaemonRegistration): EffectGen<void, string> {
    const fs = this.getDependency(FileSystem.FileSystem);

    // Files first, then the OS. The order is not cosmetic: deregistering is what stops the daemon, and on
    // macOS `launchctl bootout` kills this very process — so anything left until afterwards never happens.
    // An earlier version removed the files second and left the plist and the record behind every time.
    for (const file of registration.files) {
      yield* this.fsOp(fs.remove(file, { force: true }));
    }
    yield* Effect.log(`Removed daemon ${registration.id}`);

    if (registration.unregister.length > 0) {
      // Best effort: a unit that is already gone is the outcome we wanted, and with its files deleted a
      // refusal costs only one more start, at the next login, of a daemon that then removes nothing.
      if (!(yield* spawnQuietly(this.dependencies.OSPlatform, registration.unregister))) {
        yield* Effect.log(`Could not run ${registration.unregister.join(" ")} while removing ${registration.id}`);
      }
    }
  }

  private *registryDir(): EffectGen<string, string> {
    return resolve(yield* this.dependencies.OSPlatform.getHomeDirectory(), DAEMON_HOME_DIR, DAEMON_REGISTRY_SUBDIR);
  }

  private fsOp<A>(effect: Effect.Effect<A, { readonly message: string }>): Effect.Effect<A, string> {
    return pipe(effect, Effect.mapError((e) => e.message));
  }
}

/** A `~/.jive/daemons/<id>.json` record as the installer writes it, every field required. */
const RecordedRegistration = Schema.fromJsonString(Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  packageName: Schema.String,
  packageDir: Schema.String,
  workingDirectory: Schema.String,
  kind: Schema.Literals(["launchd", "systemd", "scheduled-task"]),
  unit: Schema.String,
  logPath: Schema.String,
  executable: Schema.String,
  registeredAt: Schema.String,
  searchPath: Schema.String,
  files: Schema.Array(Schema.String),
  unregister: Schema.Array(Schema.String),
}));

/** The one field a broken record needs for its package to be found and reinstalled. */
const RecordedPackageDir = Schema.fromJsonString(Schema.Struct({ packageDir: Schema.String }));

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * How each service manager is asked about a unit, and how its answer is read.
 *
 * One probe per `kind` rather than per host platform, because the record says which registrar ran: a
 * registry copied between machines still describes what it describes.
 */
const STATUS_PROBES: Record<DaemonRegistration["kind"], {
  readonly command: (registration: DaemonRegistration) => { command: string; args: string[] };
  readonly read: (stdout: string) => { state: DaemonStatus["state"]; pid: Option.Option<number> };
}> = {
  launchd: {
    command: (registration) => ({ command: "launchctl", args: ["list", registration.unit] }),
    // `launchctl list <label>` prints a plist dict; a loaded-but-not-running job simply has no PID key.
    read: (stdout) => {
      const pid = /"PID"\s*=\s*(\d+)/.exec(stdout)?.[1];
      return pid === undefined
        ? { state: "stopped", pid: Option.none() }
        : { state: "running", pid: Option.some(Number(pid)) };
    },
  },
  systemd: {
    command: (registration) => ({
      command: "systemctl",
      args: ["--user", "show", "--property=ActiveState", "--property=MainPID", registration.unit],
    }),
    read: (stdout) => {
      const active = /ActiveState=(\S+)/.exec(stdout)?.[1];
      const mainPid = Number(/MainPID=(\d+)/.exec(stdout)?.[1] ?? 0);
      return {
        state: active === "active" ? "running" : active === undefined ? "unknown" : "stopped",
        pid: mainPid > 0 ? Option.some(mainPid) : Option.none(),
      };
    },
  },
  "scheduled-task": {
    command: (registration) => ({
      command: "schtasks",
      args: ["/Query", "/TN", registration.unit, "/FO", "LIST"],
    }),
    // Task Scheduler reports the task, not the process, so there is no pid to report.
    read: (stdout) => ({
      state: /Status:\s*Running/i.test(stdout) ? "running" : "stopped",
      pid: Option.none(),
    }),
  },
};

/** Runs a command for its exit status alone, treating a failure to spawn as a failure to run. */
function* spawnQuietly(osPlatform: IOSPlatform, argv: ReadonlyArray<string>): EffectGen<boolean> {
  const [command, ...args] = argv;
  const result = yield* Effect.result(
    effunct(osPlatform.spawnProcess.bind(osPlatform))({ command: command!, args }),
  );
  return result._tag === "Success" && result.success.exitCode === 0;
}
