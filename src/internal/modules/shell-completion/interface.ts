import type { Option } from "effect";
import type { EffectGen } from "effective-modules";

export type Shell = "bash" | "zsh" | "fish";

/** Where one command's Tab completion lives for one shell. */
export interface CompletionFiles {
  readonly shell: Shell;
  /** The script the shell loads. */
  readonly scriptPath: string;
  /** The startup file that loads the script; none for fish, which loads completion scripts by itself. */
  readonly startupFile: Option.Option<string>;
}

/**
 * Turning Tab completion for a command on and off in the current user's shell, the one `SHELL` names.
 *
 * Bash and zsh load the script from a guarded line in their startup file, so deleting the script by hand
 * leaves the line harmless; fish needs no line, since it loads any script in its completions directory.
 */
export interface IShellCompletion {
  /** Writes the script and the startup file's line, replacing an earlier setup of the same command. */
  setUp(commandName: string): EffectGen<CompletionFiles, string>;
  /**
   * Removes the script and the startup file's line, whichever of them exist, and records that completion was
   * turned off, so the launcher stub does not set it up again until `setUp` runs.
   */
  remove(commandName: string): EffectGen<CompletionFiles, string>;
}
