import { Effect, FileSystem, Option, Result, pipe } from "effect";
import { implementing, effunct, type EffectGen } from "effective-modules";
import { basename, delimiter, dirname, join } from "node:path";
import { DAEMON_HOME_DIR } from "../../common/constants";
import { COMPLETION_PROTOCOL, COMPLETION_PROTOCOL_FLAG } from "../../public/cli/parse";
import { libraryModules } from "../index";
import { MissingCompletion, type CompletionSetup, type IShellCompletion, type Shell } from "./interface";
import { startupBlock, withStartupBlock, withoutStartupBlock } from "./scripts";

/** Under the home directory: the record that completion was turned off for a command, whichever the shell. */
const TURNED_OFF_DIR = [DAEMON_HOME_DIR, "completions"];
/** macOS terminals start login shells, which read .bash_profile and not .bashrc. */
const BASH_STARTUP_FILE_BY_PLATFORM: Readonly<Record<string, string>> = { darwin: ".bash_profile" };
/** The PowerShells a Windows machine can have side by side, each with its own profile; elsewhere only `pwsh`. */
const POWERSHELLS_BY_PLATFORM: Readonly<Record<string, ReadonlyArray<string>>> = { win32: ["pwsh", "powershell"] };
/** Execution policies under which PowerShell skips an unsigned profile. */
const PROFILE_BLOCKING_POLICIES: ReadonlyArray<string> = ["Restricted", "AllSigned"];
/** Directories package managers put first on PATH while running a project's scripts or `npx`/`bunx`. */
const PACKAGE_MANAGER_BIN_DIR = /[\\/]node_modules[\\/]\.bin[\\/]?$/;
const PATH_COMMAND_TIMEOUT_MS = 5_000;
const POWERSHELL_TIMEOUT_MS = 30_000;

/** A file holding the line, and whether it holds nothing else, so removing completion deletes it. */
interface CompletionFile {
  readonly path: string;
  readonly ownedByCommand: boolean;
}

export class ShellCompletionImpl extends implementing(libraryModules.ShellCompletion)
  .uses(libraryModules.OSPlatform, FileSystem.FileSystem)
  implements IShellCompletion {

  *setUp(commandName: string): EffectGen<CompletionSetup, string> {
    const shell = yield* this.requireUserShell();
    const { files, warnings } = yield* this.locate(commandName, shell);
    const fs = this.getDependency(FileSystem.FileSystem);
    const block = startupBlock(shell, commandName);
    for (const file of files) {
      const content = yield* this.readIfPresent(file.path);
      yield* pipe(
        fs.makeDirectory(dirname(file.path), { recursive: true }),
        Effect.andThen(fs.writeFileString(file.path, withStartupBlock(content, commandName, block))),
        Effect.mapError((e) => `Could not write ${file.path}: ${e.message}`),
      );
    }
    const turnedOff = yield* this.turnedOffMarker(commandName);
    yield* pipe(fs.remove(turnedOff, { force: true }), Effect.mapError((e) => `Could not remove ${turnedOff}: ${e.message}`));
    return { shell, files: files.map((file) => file.path), warnings };
  }

  *setUpMissing(commandName: string): EffectGen<MissingCompletion, string> {
    const os = this.dependencies.OSPlatform;
    if (Option.isSome(yield* os.readEnv("CI"))) return MissingCompletion.OnBuildAgent();
    if (yield* this.exists(yield* this.turnedOffMarker(commandName))) return MissingCompletion.TurnedOff();
    const maybeShell = yield* this.userShell();
    if (Result.isFailure(maybeShell)) return MissingCompletion.NoSupportedShell({ reason: maybeShell.failure });

    const { files } = yield* this.locate(commandName, maybeShell.success);
    // Exactly the current line, so an older or commented-out block between the same markers is replaced.
    const block = startupBlock(maybeShell.success, commandName);
    let missing = false;
    for (const file of files) {
      if (!(yield* this.readIfPresent(file.path)).includes(block)) missing = true;
    }
    if (!missing) return MissingCompletion.AlreadySetUp();
    // Checked last: it can start the command found on PATH to ask which completion it speaks.
    if (!(yield* this.servedFromUserPath(commandName))) return MissingCompletion.NotOnPath();
    return MissingCompletion.SetUp({ setup: yield* this.setUp(commandName) });
  }

  *setUpMissingOncePerVersion(commandName: string, version: string): EffectGen<MissingCompletion, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const home = yield* this.dependencies.OSPlatform.getHomeDirectory();
    const checked = join(home, ...TURNED_OFF_DIR, `${commandName}.checked`);
    if ((yield* this.readIfPresent(checked)).trim() === version) return MissingCompletion.CheckedBefore();
    const outcome = yield* this.setUpMissing(commandName);
    // A build agent checks every run, since its home is usually fresh; everywhere else this version is done.
    if (outcome._tag !== "OnBuildAgent") {
      yield* pipe(
        fs.makeDirectory(dirname(checked), { recursive: true }),
        Effect.andThen(fs.writeFileString(checked, `${version}\n`)),
        Effect.mapError((e) => `Could not write ${checked}: ${e.message}`),
      );
    }
    return outcome;
  }

  *remove(commandName: string): EffectGen<CompletionSetup, string> {
    const shell = yield* this.requireUserShell();
    const { files, warnings } = yield* this.locate(commandName, shell);
    const fs = this.getDependency(FileSystem.FileSystem);
    for (const file of files) {
      if (file.ownedByCommand) {
        yield* pipe(fs.remove(file.path, { force: true }), Effect.mapError((e) => `Could not remove ${file.path}: ${e.message}`));
        continue;
      }
      const content = yield* this.readIfPresent(file.path);
      const cleaned = withoutStartupBlock(content, commandName);
      if (cleaned !== content) {
        yield* pipe(fs.writeFileString(file.path, cleaned), Effect.mapError((e) => `Could not write ${file.path}: ${e.message}`));
      }
    }
    const turnedOff = yield* this.turnedOffMarker(commandName);
    yield* pipe(
      fs.makeDirectory(dirname(turnedOff), { recursive: true }),
      Effect.andThen(fs.writeFileString(turnedOff, `Tab completion for ${commandName} was turned off with --remove-completion.\n`)),
      Effect.mapError((e) => `Could not write ${turnedOff}: ${e.message}`),
    );
    return { shell, files: files.map((file) => file.path), warnings };
  }

  /**
   * Whether typing the name in a new shell would run a command that serves this completion. PATH is searched
   * without the `node_modules/.bin` directories a package manager adds while it runs a project's scripts, so a
   * copy installed in a project, and run through its package manager, does not count. The command found is
   * this copy when both resolve to the same file; otherwise (a shim, as Windows and pnpm install, or another
   * copy) it is asked which completion protocol it speaks.
   */
  private *servedFromUserPath(commandName: string): EffectGen<boolean> {
    const os = this.dependencies.OSPlatform;
    const path = Option.getOrElse(yield* os.readEnv("PATH"), () => "");
    const searchPath = path.split(delimiter).filter((dir) => dir !== "" && !PACKAGE_MANAGER_BIN_DIR.test(dir)).join(delimiter);
    const maybeFound = yield* os.findExecutable(commandName, { searchPath });
    if (Option.isNone(maybeFound)) return false;

    const fs = this.getDependency(FileSystem.FileSystem);
    const realPath = (path: string) => pipe(fs.realPath(path), Effect.option);
    const found = yield* realPath(maybeFound.value);
    const own = yield* realPath(yield* os.getExecutablePath());
    if (Option.isSome(found) && Option.isSome(own) && found.value === own.value) return true;

    const answer = yield* Effect.result(effunct(function* () {
      return yield* os.spawnProcess({
        command: maybeFound.value,
        args: [COMPLETION_PROTOCOL_FLAG],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeoutMs: PATH_COMMAND_TIMEOUT_MS,
      });
    })());
    return Result.isSuccess(answer) && answer.success.exitCode === 0 && answer.success.stdout.trim() === COMPLETION_PROTOCOL;
  }

  /** Present while completion is turned off; under the Jive home, whichever the shell. */
  private *turnedOffMarker(commandName: string): EffectGen<string> {
    const home = yield* this.dependencies.OSPlatform.getHomeDirectory();
    return join(home, ...TURNED_OFF_DIR, `${commandName}.off`);
  }

  /** The shell `SHELL` names, PowerShell on Windows when it is unset, or why there is none to complete for. */
  private *userShell(): EffectGen<Result.Result<Shell, string>> {
    const os = this.dependencies.OSPlatform;
    const maybeShellPath = yield* os.readEnv("SHELL");
    if (Option.isNone(maybeShellPath)) {
      const { os: platform } = yield* os.getCurrentPlatform();
      return platform === "win32" ? Result.succeed("powershell") : Result.fail("SHELL is not set, so there is no shell to set up.");
    }
    const name = basename(maybeShellPath.value).replace(/\.exe$/i, "");
    const shell: Option.Option<Shell> = name === "bash" || name === "zsh" || name === "fish" ? Option.some(name)
      : name === "pwsh" || name === "powershell" ? Option.some("powershell")
      : Option.none();
    return Option.match(shell, {
      onNone: () => Result.fail(`Tab completion supports bash, zsh, fish and PowerShell; SHELL is ${maybeShellPath.value}.`),
      onSome: (supported) => Result.succeed(supported),
    });
  }

  private *requireUserShell(): EffectGen<Shell, string> {
    const maybeShell = yield* this.userShell();
    return Result.isSuccess(maybeShell) ? maybeShell.success : yield* Effect.fail(maybeShell.failure);
  }

  /** Where a shell reads the line from, and anything that stops it reading it. */
  private *locate(commandName: string, shell: Shell): EffectGen<{ files: ReadonlyArray<CompletionFile>; warnings: ReadonlyArray<string> }, string> {
    if (!/^[A-Za-z0-9._-]+$/.test(commandName)) {
      return yield* Effect.fail(`'${commandName}' is not a command name a shell can complete.`);
    }
    const os = this.dependencies.OSPlatform;
    const home = yield* os.getHomeDirectory();
    const shared = (path: string) => ({ files: [{ path, ownedByCommand: false }], warnings: [] });
    switch (shell) {
      case "bash": {
        const { os: platform } = yield* os.getCurrentPlatform();
        const platformFile = BASH_STARTUP_FILE_BY_PLATFORM[platform];
        return shared(join(home, platformFile !== undefined ? platformFile : ".bashrc"));
      }
      case "zsh":
        return shared(join(Option.getOrElse(yield* os.readEnv("ZDOTDIR"), () => home), ".zshrc"));
      case "fish": {
        // Fish loads completions/<command>.fish the first time the command is completed, so it needs no startup line.
        const configHome = Option.getOrElse(yield* os.readEnv("XDG_CONFIG_HOME"), () => join(home, ".config"));
        return { files: [{ path: join(configHome, "fish", "completions", `${commandName}.fish`), ownedByCommand: true }], warnings: [] };
      }
      case "powershell":
        return yield* this.powerShellProfiles();
    }
  }

  /**
   * Each installed PowerShell's own profile for the current user in every host, asked of PowerShell itself
   * (`$PROFILE.CurrentUserAllHosts`), since where it lives differs by edition and platform and follows a
   * Documents folder that OneDrive may have moved. Also notes an execution policy that stops profiles running;
   * the policy is the user's to change, so it is never changed here.
   */
  private *powerShellProfiles(): EffectGen<{ files: ReadonlyArray<CompletionFile>; warnings: ReadonlyArray<string> }, string> {
    const os = this.dependencies.OSPlatform;
    const { os: platform } = yield* os.getCurrentPlatform();
    const platformNames = POWERSHELLS_BY_PLATFORM[platform];
    const names = platformNames !== undefined ? platformNames : ["pwsh"];
    const files: Array<CompletionFile> = [];
    const warnings: Array<string> = [];
    for (const name of names) {
      const maybeExecutable = yield* os.findExecutable(name);
      if (Option.isNone(maybeExecutable)) continue;
      const result = yield* os.spawnProcess({
        command: maybeExecutable.value,
        args: ["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts; Get-ExecutionPolicy"],
        timeoutMs: POWERSHELL_TIMEOUT_MS,
      });
      const [profile, policy] = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
      if (result.exitCode !== 0 || profile === undefined) {
        return yield* Effect.fail(`Could not ask ${maybeExecutable.value} where its profile is: ${result.stderr.trim()}`);
      }
      files.push({ path: profile, ownedByCommand: false });
      if (policy !== undefined && PROFILE_BLOCKING_POLICIES.includes(policy)) {
        warnings.push(`${name}'s execution policy is ${policy}, which stops it running ${profile}; completion loads once it allows local scripts (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned).`);
      }
    }
    if (files.length === 0) return yield* Effect.fail(`No PowerShell is installed: looked for ${names.join(" and ")} on PATH.`);
    return { files, warnings };
  }

  private *exists(path: string): EffectGen<boolean, string> {
    return yield* pipe(this.getDependency(FileSystem.FileSystem).exists(path), Effect.mapError((e) => `Could not read ${path}: ${e.message}`));
  }

  private *readIfPresent(path: string): EffectGen<string, string> {
    if (!(yield* this.exists(path))) return "";
    return yield* pipe(this.getDependency(FileSystem.FileSystem).readFileString(path), Effect.mapError((e) => `Could not read ${path}: ${e.message}`));
  }
}
