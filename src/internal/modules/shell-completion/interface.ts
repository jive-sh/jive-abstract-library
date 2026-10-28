import { Data, type Option } from "effect";
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

/** What setting completion up when it is missing did. */
export type MissingCompletion = Data.TaggedEnum<{
  /** It was missing, and is now set up in these files. */
  SetUp: { readonly files: CompletionFiles };
  AlreadySetUp: {};
  /** `--remove-completion` was run, and setting it up again is left to `--setup-completion`. */
  TurnedOff: {};
  /** `SHELL` is unset or names a shell there is no completion for. */
  UnsupportedShell: {};
}>;
export const MissingCompletion = Data.taggedEnum<MissingCompletion>();

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
   * turned off, so `setUpIfMissing` leaves it off until `setUp` runs again.
   */
  remove(commandName: string): EffectGen<CompletionFiles, string>;
  /** Sets completion up unless it already is, was turned off, or the shell has none. */
  setUpIfMissing(commandName: string): EffectGen<MissingCompletion, string>;
}
