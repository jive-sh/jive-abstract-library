import { DAEMON_HOME_DIR } from "../../common/constants";
import type { Shell } from "./interface";

/**
 * Where each shell's completion for a command lives, as plain data, because two programs read it: the
 * ShellCompletion module, which writes the files, and the launcher stub, plain JavaScript rendered at build,
 * which checks whether they are there. The stub gets this object verbatim, so neither can move a file the other
 * does not know about. `{command}` stands for the command's name.
 */
export const COMPLETION_LOCATIONS = {
  shells: ["bash", "zsh", "fish"] satisfies ReadonlyArray<Shell>,
  /** Under the home directory; bash's and zsh's scripts, and the record that completion was turned off. */
  jiveCompletionsDir: [DAEMON_HOME_DIR, "completions"],
  turnedOffFile: "{command}.off",
  blockStart: "# begin {command} completion",
  blockEnd: "# end {command} completion",
  bash: {
    /** macOS terminals start login shells, which read .bash_profile and not .bashrc. */
    startupFileByPlatform: { darwin: ".bash_profile" } as Readonly<Record<string, string>>,
    defaultStartupFile: ".bashrc",
  },
  zsh: { startupDirectoryEnv: "ZDOTDIR", startupFile: ".zshrc" },
  /** Fish loads any script in its completions directory, so it needs no startup file line. */
  fish: { configHomeEnv: "XDG_CONFIG_HOME", defaultConfigHome: ".config", completionsDir: ["fish", "completions"] },
} as const;

export const forCommand = (template: string, commandName: string): string => template.replace("{command}", commandName);
