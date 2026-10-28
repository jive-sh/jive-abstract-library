import { Effect, Option, Result } from "effect";
import { listChoices } from "./choices";
import { HELP_FLAGS, REMOVE_COMPLETION_FLAG, SET_UP_COMPLETION_FLAG, VERSION_FLAG } from "./parse";
import { isChoice, isCommand, type Cli, type Command, type FlagSet, type Group, type Node } from "./tree";

/**
 * The help for the place in the tree reading stopped at. A choice's help lists its values, so it runs the
 * choice's `choices`; what that needs is in `R` of the CLI already.
 */
export function renderHelp(cli: Cli<any, any>, node: Node, path: ReadonlyArray<string>): Effect.Effect<string, never, any> {
  const isRoot = node === cli.commands;
  if (isCommand(node)) return Effect.succeed(commandHelp(node, path));
  if (isChoice(node)) {
    return Effect.map(listChoices(node.choices), (listed) => sections([
      `Usage: ${[...path, "<choice>"].join(" ")}`,
      ...Option.toArray(node.description),
      Result.isSuccess(listed)
        ? listed.success.length === 0 ? "Choices: none right now." : `Choices:\n${table([...listed.success].sort().map((value) => [value, ""]))}`
        : `Choices: could not be listed: ${listed.failure}`,
    ]));
  }
  return Effect.succeed(groupHelp(node, path, isRoot));
}

function groupHelp(group: Group, path: ReadonlyArray<string>, isRoot: boolean): string {
  const commands = Object.keys(group).sort().map((name) => [name, Option.getOrElse(nodeDescription(group[name]!), () => "")] as const);
  const flags: Array<readonly [string, string]> = [[HELP_FLAGS.join(", "), "Show this help"]];
  if (isRoot) {
    flags.push(
      [VERSION_FLAG, "Print the version"],
      [SET_UP_COMPLETION_FLAG, `Turn on Tab completion for ${path[0]} in your shell`],
      [REMOVE_COMPLETION_FLAG, `Turn off Tab completion for ${path[0]} in your shell`],
    );
  }
  return sections([
    `Usage: ${[...path, "<command>"].join(" ")}`,
    commands.length === 0 ? "Commands: none." : `Commands:\n${table(commands)}`,
    `Flags:\n${table(flags)}`,
  ]);
}

function commandHelp(command: Command<any, any, any>, path: ReadonlyArray<string>): string {
  const flags: FlagSet = command.flags;
  const declared = Object.entries(flags).map(([name, flag]) => [
    flag._tag === "BooleanFlag" ? `--${name}` : `--${name} <value>`,
    Option.getOrElse(flag.description, () => ""),
  ] as const);
  return sections([
    `Usage: ${[...path, "[flags]"].join(" ")}`,
    ...Option.toArray(command.description),
    `Flags:\n${table([...declared, [HELP_FLAGS.join(", "), "Show this help"]])}`,
  ]);
}

export function nodeDescription(node: Node): Option.Option<string> {
  return isCommand(node) || isChoice(node) ? node.description : Option.none();
}

function sections(parts: ReadonlyArray<string>): string {
  return `${parts.join("\n\n")}\n`;
}

/** Two columns, the second lined up; a row with no second column is just its first. */
function table(rows: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => right === "" ? `  ${left}` : `  ${left.padEnd(width)}   ${right}`).join("\n");
}
