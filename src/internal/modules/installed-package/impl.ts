import { createRequire } from "node:module";
import * as path from "node:path";
import { Effect, FileSystem, Option, Schema, SchemaIssue, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { PLATFORMS } from "../builder/interface";
import { libraryModules } from "../index";
import { detectInstall } from "./detect";
import type { IInstalledPackage, Install, InstallRun } from "./interface";
import { installSteps, powerShellProgram, shellScript } from "./steps";

const DistTags = Schema.Record(Schema.String, Schema.String);
const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class InstalledPackageImpl extends implementing(libraryModules.InstalledPackage)
  .uses(libraryModules.OSPlatform, FileSystem.FileSystem)
  implements IInstalledPackage {

  *detect(input: { readonly packageName: string; readonly commandPath: string; readonly searchPath: string }): EffectGen<Option.Option<Install>> {
    return yield* Effect.sync(() => detectInstall({ ...input, environment: process.env }));
  }

  *version(install: Install): EffectGen<string, string> {
    const manifestPath = path.join(install.packageDir, "package.json");
    const text = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readFileString(manifestPath),
      Effect.mapError((e) => `Cannot read ${manifestPath}: ${e.message}`),
    );
    return yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ version: Schema.NonEmptyString })))(text),
      Effect.map(({ version }) => version),
      Effect.catchTag("SchemaError", (e) => Effect.fail(`${manifestPath} has no version: ${formatSchemaError(e.issue)}`)),
    );
  }

  /**
   * Resolved from the package's directory as Node would resolve it, which finds the platform package
   * wherever the manager put it (beside it, or nested under it). When several are installed — npm's `--cpu`
   * and `--os` flags allow that — the one matching this process wins, which is the launcher's rule too.
   */
  *platform(input: { readonly packageName: string; readonly install: Install }): EffectGen<Option.Option<string>> {
    const { os, cpu } = yield* this.dependencies.OSPlatform.getCurrentPlatform();
    return yield* Effect.sync(() => {
      const resolve = createRequire(path.join(input.install.packageDir, "package.json")).resolve;
      const installed = PLATFORMS.filter((platform) => {
        try {
          resolve(`${input.packageName}-${platform.id}/package.json`);
          return true;
        } catch {
          return false;
        }
      });
      const chosen = installed.length === 1
        ? installed[0]
        : installed.find((platform) => platform.os === os && platform.cpu === cpu);
      return Option.map(Option.fromUndefinedOr(chosen), (platform) => platform.id);
    });
  }

  *distTags(input: { readonly packageName: string; readonly install: Install }): EffectGen<Readonly<Record<string, string>>, string> {
    const { packageName, install } = input;
    const argv = install.packageManager === "yarn" || install.packageManager === "bun"
      ? [install.packageManager, "info", packageName, "dist-tags", "--json"]
      : [install.packageManager, "view", packageName, "dist-tags", "--json"];
    const result = yield* this.dependencies.OSPlatform.spawnProcess({
      command: argv[0]!, args: argv.slice(1), cwd: install.cwd, env: install.env,
    });
    const failure = `${argv.join(" ")} failed in ${install.cwd}`;
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`${failure} with exit code ${result.exitCode}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
    }

    // Yarn classic prints one JSON event per line, and exits zero even when the request failed.
    const json = install.packageManager === "yarn" ? yarnInspectData(result.stdout) : Option.some(result.stdout);
    if (Option.isNone(json)) return yield* Effect.fail(`${failure}:\n${[result.stdout, result.stderr].join("\n").trim()}`);
    return yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(DistTags))(json.value),
      Effect.catchTag("SchemaError", (e) => Effect.fail(`${failure}: unexpected output: ${formatSchemaError(e.issue)}`)),
    );
  }

  *installVersion(input: {
    readonly packageName: string;
    readonly install: Install;
    readonly version: string;
    readonly run: InstallRun;
  }): EffectGen<void, string> {
    const { install, run } = input;
    const steps = installSteps(input);
    const osPlatform = this.dependencies.OSPlatform;

    if (run._tag === "AfterExit") {
      yield* osPlatform.startDetached({
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", powerShellProgram({
          steps, cwd: install.cwd, pid: process.pid, afterFailure: run.afterFailure,
        })],
        cwd: install.cwd,
        env: install.env,
      });
      return;
    }

    if (run._tag === "Detached") {
      const script = shellScript(steps, install.cwd);
      // systemd-run starts the unit from the user manager, which knows nothing of this process's
      // environment, so what the install needs is passed explicitly.
      const command = run.systemdUnit
        ? {
          command: "systemd-run",
          args: [
            "--user", "--wait", "--collect",
            ...["PATH", "BUN_INSTALL", "PNPM_HOME"]
              .flatMap((name) => install.env[name] === undefined ? [] : [`--setenv=${name}=${install.env[name]}`]),
            "/bin/sh", "-c", script,
          ],
        }
        : { command: "/bin/sh", args: ["-c", script] };
      const exitCode = yield* osPlatform.runDetached({ ...command, cwd: install.cwd, env: install.env });
      if (exitCode !== 0) return yield* Effect.fail(`installing ${input.packageName}@${input.version} exited with code ${exitCode}`);
      return;
    }

    for (const step of steps) {
      // The new version's install script exists only once the install has run, so it is checked here.
      if (Option.isSome(step.onlyIfExists)
        && !(yield* pipe(this.getDependency(FileSystem.FileSystem).exists(step.onlyIfExists.value), Effect.orElseSucceed(() => false)))) {
        continue;
      }
      yield* Effect.log(`Running: ${step.argv.join(" ")}`);
      const result = yield* osPlatform.spawnProcess({
        command: step.argv[0]!, args: step.argv.slice(1), cwd: install.cwd, env: install.env, stdout: "inherit", stderr: "inherit",
      });
      if (result.exitCode !== 0) return yield* Effect.fail(`${step.argv.join(" ")} exited with code ${result.exitCode}`);
    }
  }
}

function yarnInspectData(stdout: string): Option.Option<string> {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: unknown };
      if (event.type === "inspect") return Option.some(JSON.stringify(event.data));
    } catch {
      // Not an event line.
    }
  }
  return Option.none();
}
