import { Data } from "effect";
import type { EffectGen } from "effective-modules";

export const SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type Shell = (typeof SHELLS)[number];

/** Where one command's Tab completion is loaded from for one shell. */
export interface CompletionSetup {
  readonly shell: Shell;
  /**
   * Each file holding the line that loads the completion: bash's or zsh's startup file, fish's completions file
   * for the command, or the profile of each installed PowerShell.
   */
  readonly files: ReadonlyArray<string>;
  /** Why the shell may not run those files yet, such as PowerShell's execution policy stopping profiles. */
  readonly warnings: ReadonlyArray<string>;
}

/** What setting up missing completion found, and did when nothing stopped it. */
export type MissingCompletion = Data.TaggedEnum<{
  SetUp: { readonly setup: CompletionSetup };
  AlreadySetUp: {};
  /** Turned off with `--remove-completion`. */
  TurnedOff: {};
  /** `CI` is set: a build agent's shell is never opened by a person. */
  OnBuildAgent: {};
  /**
   * Typing the command's name in a new shell would not run a command that serves this completion: this copy is
   * installed in a project, run through its package manager, and nothing on the user's own PATH has the name.
   */
  NotOnPath: {};
  NoSupportedShell: { readonly reason: string };
  /** This version of the command already checked, on an earlier run. */
  CheckedBefore: {};
}>;
export const MissingCompletion = Data.taggedEnum<MissingCompletion>();

/**
 * Turning Tab completion for a command on and off in the current user's shell: the one `SHELL` names, or
 * PowerShell on Windows when `SHELL` is unset.
 *
 * Each shell gets one guarded line between `# begin <command> completion` and `# end <command> completion`. At
 * every shell start it runs `<command> --completion <shell>` and evaluates the script that prints, if the command
 * is installed; so the script always matches the installed version, and uninstalling the command leaves a line
 * that does nothing.
 */
export interface IShellCompletion {
  /** Writes the line, replacing an earlier one for the same command, and clears a turned-off record. */
  setUp(commandName: string): EffectGen<CompletionSetup, string>;
  /**
   * Sets up completion unless it is already set up as `setUp` would write it, was turned off, this is a build
   * agent, or typing the name in a new shell would not run a command that serves it (`MissingCompletion`).
   */
  setUpMissing(commandName: string): EffectGen<MissingCompletion, string>;
  /**
   * `setUpMissing`, once per installed version of the command: the first run of each version checks, and records the
   * version so later runs return `CheckedBefore` at the cost of one small file read. The command calls this on every
   * run, so completion is set up even when the package manager skipped the install script.
   */
  setUpMissingOncePerVersion(commandName: string, version: string): EffectGen<MissingCompletion, string>;
  /**
   * Removes the line wherever it is, and records that completion was turned off, so `setUpMissing` leaves it off
   * until `setUp` runs.
   */
  remove(commandName: string): EffectGen<CompletionSetup, string>;
}
