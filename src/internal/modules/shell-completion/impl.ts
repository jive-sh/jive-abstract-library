import { Effect, FileSystem, Option, Result, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { basename, dirname, join } from "node:path";
import { DAEMON_HOME_DIR } from "../../common/constants";
import { libraryModules } from "../index";
import { MissingCompletion, type CompletionFiles, type IShellCompletion, type Shell } from "./interface";
import { completionScript, hasStartupBlock, startupBlock, withStartupBlock, withoutStartupBlock } from "./scripts";

const SHELLS: ReadonlyArray<Shell> = ["bash", "zsh", "fish"];
/** Under the Jive home directory, beside daemons and logs. Fish's scripts go in fish's own directory instead. */
const COMPLETIONS_SUBDIR = "completions";

export class ShellCompletionImpl extends implementing(libraryModules.ShellCompletion)
  .uses(libraryModules.OSPlatform, FileSystem.FileSystem)
  implements IShellCompletion {

  *setUp(commandName: string): EffectGen<CompletionFiles, string> {
    const files = yield* this.locate(commandName);
    const fs = this.getDependency(FileSystem.FileSystem);
    yield* pipe(
      fs.makeDirectory(dirname(files.scriptPath), { recursive: true }),
      Effect.andThen(fs.writeFileString(files.scriptPath, completionScript(files.shell, commandName))),
      Effect.mapError((e) => `Could not write ${files.scriptPath}: ${e.message}`),
    );
    const turnedOff = yield* this.turnedOffMarker(commandName);
    yield* pipe(fs.remove(turnedOff, { force: true }), Effect.mapError((e) => `Could not remove ${turnedOff}: ${e.message}`));
    if (Option.isSome(files.startupFile)) {
      const startupFile = files.startupFile.value;
      const content = yield* this.readIfPresent(startupFile);
      yield* pipe(
        fs.writeFileString(startupFile, withStartupBlock(content, commandName, startupBlock(commandName, files.scriptPath))),
        Effect.mapError((e) => `Could not write ${startupFile}: ${e.message}`),
      );
    }
    return files;
  }

  *remove(commandName: string): EffectGen<CompletionFiles, string> {
    const files = yield* this.locate(commandName);
    const fs = this.getDependency(FileSystem.FileSystem);
    yield* pipe(
      fs.remove(files.scriptPath, { force: true }),
      Effect.mapError((e) => `Could not remove ${files.scriptPath}: ${e.message}`),
    );
    if (Option.isSome(files.startupFile)) {
      const startupFile = files.startupFile.value;
      const content = yield* this.readIfPresent(startupFile);
      const cleaned = withoutStartupBlock(content, commandName);
      if (cleaned !== content) {
        yield* pipe(
          fs.writeFileString(startupFile, cleaned),
          Effect.mapError((e) => `Could not write ${startupFile}: ${e.message}`),
        );
      }
    }
    const turnedOff = yield* this.turnedOffMarker(commandName);
    yield* pipe(
      fs.makeDirectory(dirname(turnedOff), { recursive: true }),
      Effect.andThen(fs.writeFileString(turnedOff, `Tab completion for ${commandName} was turned off with --remove-completion.\n`)),
      Effect.mapError((e) => `Could not write ${turnedOff}: ${e.message}`),
    );
    return files;
  }

  *setUpIfMissing(commandName: string): EffectGen<MissingCompletion, string> {
    if (Result.isFailure(yield* this.userShell())) return MissingCompletion.UnsupportedShell();
    const fs = this.getDependency(FileSystem.FileSystem);
    const exists = (path: string) => pipe(fs.exists(path), Effect.mapError((e) => `Could not read ${path}: ${e.message}`));
    if (yield* exists(yield* this.turnedOffMarker(commandName))) return MissingCompletion.TurnedOff();

    const files = yield* this.locate(commandName);
    const startupLoadsIt = Option.isNone(files.startupFile)
      || hasStartupBlock(yield* this.readIfPresent(files.startupFile.value), commandName);
    if ((yield* exists(files.scriptPath)) && startupLoadsIt) return MissingCompletion.AlreadySetUp();
    return MissingCompletion.SetUp({ files: yield* this.setUp(commandName) });
  }

  /** Present while completion is turned off; under the Jive home, whichever the shell. */
  private *turnedOffMarker(commandName: string): EffectGen<string> {
    const home = yield* this.dependencies.OSPlatform.getHomeDirectory();
    return join(home, DAEMON_HOME_DIR, COMPLETIONS_SUBDIR, `${commandName}.off`);
  }

  /** The shell `SHELL` names, or why there is none to complete for. */
  private *userShell(): EffectGen<Result.Result<Shell, string>> {
    const maybeShellPath = yield* this.dependencies.OSPlatform.readEnv("SHELL");
    if (Option.isNone(maybeShellPath)) return Result.fail("SHELL is not set, so there is no shell to set up.");
    const shellName = basename(maybeShellPath.value);
    const shell = SHELLS.find((candidate) => candidate === shellName);
    return shell === undefined
      ? Result.fail(`Tab completion supports ${SHELLS.join(", ")}; SHELL is ${maybeShellPath.value}.`)
      : Result.succeed(shell);
  }

  /** The user's shell, from `SHELL`, and where that shell looks for a command's completion. */
  private *locate(commandName: string): EffectGen<CompletionFiles, string> {
    if (!/^[A-Za-z0-9._-]+$/.test(commandName)) {
      return yield* Effect.fail(`'${commandName}' is not a command name a shell can complete.`);
    }
    const os = this.dependencies.OSPlatform;
    const maybeShell = yield* this.userShell();
    if (Result.isFailure(maybeShell)) return yield* Effect.fail(maybeShell.failure);
    const shell = maybeShell.success;

    const home = yield* os.getHomeDirectory();
    const jiveScript = join(home, DAEMON_HOME_DIR, COMPLETIONS_SUBDIR, `${commandName}.${shell}`);
    switch (shell) {
      case "bash": {
        // macOS terminals start login shells, which read .bash_profile and not .bashrc.
        const { os: platform } = yield* os.getCurrentPlatform();
        const startupFile = join(home, platform === "darwin" ? ".bash_profile" : ".bashrc");
        return { shell, scriptPath: jiveScript, startupFile: Option.some(startupFile) };
      }
      case "zsh": {
        const zdotdir = Option.getOrElse(yield* os.readEnv("ZDOTDIR"), () => home);
        return { shell, scriptPath: jiveScript, startupFile: Option.some(join(zdotdir, ".zshrc")) };
      }
      case "fish": {
        const configHome = Option.getOrElse(yield* os.readEnv("XDG_CONFIG_HOME"), () => join(home, ".config"));
        return { shell, scriptPath: join(configHome, "fish", "completions", `${commandName}.fish`), startupFile: Option.none() };
      }
    }
  }

  private *readIfPresent(path: string): EffectGen<string, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const exists = yield* pipe(fs.exists(path), Effect.mapError((e) => `Could not read ${path}: ${e.message}`));
    if (!exists) return "";
    return yield* pipe(fs.readFileString(path), Effect.mapError((e) => `Could not read ${path}: ${e.message}`));
  }
}
