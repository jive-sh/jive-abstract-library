import { Effect, FileSystem, Option, Result, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { basename, dirname, join } from "node:path";
import { libraryModules } from "../index";
import type { CompletionFiles, IShellCompletion, Shell } from "./interface";
import { COMPLETION_LOCATIONS, forCommand } from "./locations";
import { completionScript, startupBlock, withStartupBlock, withoutStartupBlock } from "./scripts";

const SHELLS: ReadonlyArray<Shell> = COMPLETION_LOCATIONS.shells;

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

  /** Present while completion is turned off; under the Jive home, whichever the shell. */
  private *turnedOffMarker(commandName: string): EffectGen<string> {
    const home = yield* this.dependencies.OSPlatform.getHomeDirectory();
    return join(home, ...COMPLETION_LOCATIONS.jiveCompletionsDir, forCommand(COMPLETION_LOCATIONS.turnedOffFile, commandName));
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
    const jiveScript = join(home, ...COMPLETION_LOCATIONS.jiveCompletionsDir, `${commandName}.${shell}`);
    switch (shell) {
      case "bash": {
        const { bash } = COMPLETION_LOCATIONS;
        const { os: platform } = yield* os.getCurrentPlatform();
        const platformFile = bash.startupFileByPlatform[platform];
        const startupFile = join(home, platformFile !== undefined ? platformFile : bash.defaultStartupFile);
        return { shell, scriptPath: jiveScript, startupFile: Option.some(startupFile) };
      }
      case "zsh": {
        const { zsh } = COMPLETION_LOCATIONS;
        const directory = Option.getOrElse(yield* os.readEnv(zsh.startupDirectoryEnv), () => home);
        return { shell, scriptPath: jiveScript, startupFile: Option.some(join(directory, zsh.startupFile)) };
      }
      case "fish": {
        const { fish } = COMPLETION_LOCATIONS;
        const configHome = Option.getOrElse(yield* os.readEnv(fish.configHomeEnv), () => join(home, fish.defaultConfigHome));
        return { shell, scriptPath: join(configHome, ...fish.completionsDir, `${commandName}.fish`), startupFile: Option.none() };
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
