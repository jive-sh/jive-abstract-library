import { Option } from "effect";
import type { Shell } from "./interface";
import { COMPLETION_LOCATIONS, forCommand } from "./locations";

/**
 * The completion script each shell loads for one command. All three do the same thing on Tab: call the command
 * with `--compgen` and the words typed after its name up to the cursor (the last being the word being
 * completed, "" after a space), then offer each line it prints, the part before a tab being the value and the
 * part after it a description. The command decides everything else, so the scripts never change with the CLI.
 *
 * Bash's script sticks to what bash 3.2 has (macOS still ships it): no `mapfile`, no `compopt`. Bash splits
 * words at `COMP_WORDBREAKS` characters before the script sees them, so a value containing `:` or `=` does
 * not complete cleanly in bash.
 */
export function completionScript(shell: Shell, commandName: string): string {
  const fn = `_${commandName.replace(/[^A-Za-z0-9_]/g, "_")}_complete`;
  const command = shellQuote(commandName);
  const header = `# Tab completion for ${commandName}, written by \`${commandName} --setup-completion\`.`;
  switch (shell) {
    case "bash":
      return `${header}
${fn}() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [ -n "$line" ] && COMPREPLY+=("\${line%%$'\\t'*}")
  done < <(${command} --compgen "\${COMP_WORDS[@]:1:COMP_CWORD}")
}
complete -F ${fn} ${command}
`;
    case "zsh":
      return `${header}
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
${fn}() {
  local -a specs
  local line value
  for line in "\${(@f)$(${command} --compgen "\${(@)words[2,CURRENT]}")}"; do
    [[ -n $line ]] || continue
    value=\${line%%$'\\t'*}
    if [[ $line == *$'\\t'* ]]; then
      specs+=("\${value//:/\\\\:}:\${line#*$'\\t'}")
    else
      specs+=("\${value//:/\\\\:}")
    fi
  done
  _describe ${command} specs
}
compdef ${fn} ${command}
`;
    case "fish":
      return `${header}
function ${fn}
    set -l typed (commandline -opc)
    set -e typed[1]
    set -l current (commandline -ct)
    ${command} --compgen $typed "$current"
end
complete -c ${command} -f -a '(${fn})'
`;
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const blockStart = (commandName: string) => `${forCommand(COMPLETION_LOCATIONS.blockStart, commandName)}\n`;
const blockEnd = (commandName: string) => `${forCommand(COMPLETION_LOCATIONS.blockEnd, commandName)}\n`;

/**
 * The lines a bash or zsh startup file gets: load the script if it is there, so a script deleted by hand
 * leaves a line that does nothing rather than one that errors at every shell start.
 */
export function startupBlock(commandName: string, scriptPath: string): string {
  const path = shellQuote(scriptPath);
  return `${blockStart(commandName)}[ -f ${path} ] && . ${path}\n${blockEnd(commandName)}`;
}

/** The startup file's text with the command's block in it: replaced where it was, appended otherwise. */
export function withStartupBlock(content: string, commandName: string, block: string): string {
  const maybeExisting = findStartupBlock(content, commandName);
  if (Option.isSome(maybeExisting)) {
    return content.slice(0, maybeExisting.value.start) + block + content.slice(maybeExisting.value.end);
  }
  const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}`;
}

/** The startup file's text without the command's block, and the blank line `withStartupBlock` put before it. */
export function withoutStartupBlock(content: string, commandName: string): string {
  const maybeExisting = findStartupBlock(content, commandName);
  if (Option.isNone(maybeExisting)) return content;
  const before = content.slice(0, maybeExisting.value.start);
  return (before.endsWith("\n\n") ? before.slice(0, -1) : before) + content.slice(maybeExisting.value.end);
}

function findStartupBlock(content: string, commandName: string): Option.Option<{ start: number; end: number }> {
  const start = content.indexOf(blockStart(commandName));
  if (start === -1) return Option.none();
  const endMarker = content.indexOf(blockEnd(commandName), start);
  if (endMarker === -1) return Option.none();
  return Option.some({ start, end: endMarker + blockEnd(commandName).length });
}
