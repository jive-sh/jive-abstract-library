import { Option } from "effect";
import { COMPGEN_FLAG, COMPLETION_SCRIPT_FLAG } from "../../public/cli/parse";
import type { Shell } from "./interface";

/**
 * The script each shell evaluates to register one command's completion, printed by `<command> --completion
 * <shell>`. All four do the same thing on Tab: call the command with `--compgen` and the words typed after its
 * name up to the cursor (the last being the word being completed, "" after a space), then offer each line it
 * prints, the part before a tab being the value and the part after it a description. The command decides
 * everything else, so the scripts never change with the CLI.
 *
 * Bash's script sticks to what bash 3.2 has (macOS still ships it): no `mapfile`, no `compopt`. Bash splits
 * words at `COMP_WORDBREAKS` characters before the script sees them, so a value containing `:` or `=` does
 * not complete cleanly in bash. PowerShell's sends an empty current word as `""` (see `parseInvocation`).
 */
export function completionScript(shell: Shell, commandName: string): string {
  const fn = `_${commandName.replace(/[^A-Za-z0-9_]/g, "_")}_complete`;
  const command = shellQuote(commandName);
  const header = `# Tab completion for ${commandName}, printed by \`${commandName} ${COMPLETION_SCRIPT_FLAG} ${shell}\`.`;
  switch (shell) {
    case "bash":
      return `${header}
${fn}() {
  local line
  COMPREPLY=()
  while IFS= read -r line; do
    [ -n "$line" ] && COMPREPLY+=("\${line%%$'\\t'*}")
  done < <(${command} ${COMPGEN_FLAG} "\${COMP_WORDS[@]:1:COMP_CWORD}")
}
complete -F ${fn} ${command}
`;
    case "zsh":
      // A `compinit` later in the startup files resets every `compdef` before it, so the script registers at once
      // when compinit has run and again once, before the first prompt, after every startup file: where its line
      // sits in .zshrc never matters. Only when nothing ran compinit by then does it run compinit itself.
      return `${header}
${fn}_register() { compdef ${fn} ${command}; }
(( $+functions[compdef] )) && ${fn}_register
autoload -Uz add-zsh-hook
${fn}_register_at_prompt() {
  (( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
  ${fn}_register
  add-zsh-hook -d precmd ${fn}_register_at_prompt
}
add-zsh-hook precmd ${fn}_register_at_prompt
${fn}() {
  local -a specs
  local line value
  for line in "\${(@f)$(${command} ${COMPGEN_FLAG} "\${(@)words[2,CURRENT]}")}"; do
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
`;
    case "fish":
      return `${header}
function ${fn}
    set -l typed (commandline -opc)
    set -e typed[1]
    set -l current (commandline -ct)
    ${command} ${COMPGEN_FLAG} $typed "$current"
end
complete -c ${command} -f -a '(${fn})'
`;
    case "powershell":
      return `${header}
Register-ArgumentCompleter -Native -CommandName ${command} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $typed = @($commandAst.CommandElements | Select-Object -Skip 1 | Where-Object { $_.Extent.EndOffset -le $cursorPosition } | ForEach-Object {
        if ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $_.Value } else { $_.Extent.Text }
    })
    if ($wordToComplete -eq '') { $typed += '""' }
    & ${command} ${COMPGEN_FLAG} @typed 2>$null | ForEach-Object {
        $value, $description = $_ -split "\`t", 2
        if ($value) {
            $tooltip = if ($description) { $description } else { $value }
            [System.Management.Automation.CompletionResult]::new($value, $value, 'ParameterValue', $tooltip)
        }
    }
}
`;
  }
}

/** Single quotes mean the same in all four shells for a command name, which `locate` limits to `[A-Za-z0-9._-]`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const blockStart = (commandName: string) => `# begin ${commandName} completion\n`;
const blockEnd = (commandName: string) => `# end ${commandName} completion\n`;

/**
 * What a shell's file gets: one line that, if the command is installed, evaluates the script it prints. So the
 * script is always the installed version's, and uninstalling the command leaves a line that does nothing.
 * `eval "$(…)"` rather than `source <(…)`, which bash 3.2 silently ignores.
 */
export function startupBlock(shell: Shell, commandName: string): string {
  const command = shellQuote(commandName);
  const script = `${command} ${COMPLETION_SCRIPT_FLAG} ${shell}`;
  const line = shell === "fish"
    ? `command -q ${command}; and ${script} | source`
    : shell === "powershell"
      ? `if (Get-Command ${command} -CommandType Application -ErrorAction SilentlyContinue) { & ${script} | Out-String | Invoke-Expression }`
      : `command -v ${command} >/dev/null 2>&1 && eval "$(${script})"`;
  return `${blockStart(commandName)}${line}\n${blockEnd(commandName)}`;
}

/** The file's text with the command's block in it: replaced where it was, appended otherwise. */
export function withStartupBlock(content: string, commandName: string, block: string): string {
  const maybeExisting = findStartupBlock(content, commandName);
  if (Option.isSome(maybeExisting)) {
    return content.slice(0, maybeExisting.value.start) + block + content.slice(maybeExisting.value.end);
  }
  const separator = content === "" ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${separator}${block}`;
}

/** The file's text without the command's block, and the blank line `withStartupBlock` put before it. */
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
