import { Data, Option } from "effect";
import { isChoice, isCommand, type Choice, type Cli, type Command, type FlagSet, type Group, type Node } from "./tree";

/**
 * Reading what was typed after the CLI's name into the one thing to do about it. Pure: a choice's `next` is
 * called to find the rest of the tree, but its `choices` never is, so a value is accepted whether or not it
 * would have been listed (the list is a suggestion for Tab, and may be slow or offline).
 */

export const HELP_FLAGS: ReadonlyArray<string> = ["--help", "-h"];
export const VERSION_FLAG = "--version";
export const SET_UP_COMPLETION_FLAG = "--setup-completion";
export const REMOVE_COMPLETION_FLAG = "--remove-completion";
/** What a shell's Tab completion calls the CLI with, followed by the words typed so far. */
export const COMPGEN_FLAG = "--compgen";
const END_OF_FLAGS = "--";

/** The root's own flags, each of which must be the only word given. */
const ROOT_ACTION_FLAGS: ReadonlyArray<string> = [VERSION_FLAG, SET_UP_COMPLETION_FLAG, REMOVE_COMPLETION_FLAG];

export type FlagValue = boolean | Option.Option<string>;

export type Invocation = Data.TaggedEnum<{
  Execute: {
    readonly command: Command<any, any, any>;
    readonly path: ReadonlyArray<string>;
    readonly flags: Readonly<Record<string, FlagValue>>;
    readonly args: ReadonlyArray<string>;
  };
  /** `--help` was given, or the words stopped before reaching a command. */
  Help: { readonly node: Node; readonly path: ReadonlyArray<string> };
  Version: {};
  /** Tab was pressed; `words` are those typed after the CLI's name, the last being the one being completed. */
  Complete: { readonly words: ReadonlyArray<string> };
  SetUpCompletion: {};
  RemoveCompletion: {};
  /** The words cannot be run; `node` and `path` are where reading stopped, whose help is shown with the message. */
  UsageError: { readonly message: string; readonly node: Node; readonly path: ReadonlyArray<string> };
  /** The CLI's own definition is wrong, which no input can fix. */
  InvalidDefinition: { readonly message: string };
}>;
export const Invocation = Data.taggedEnum<Invocation>();

export function parseInvocation(cli: Cli<any, any>, words: ReadonlyArray<string>): Invocation {
  const [first, ...rest] = words;
  if (first === COMPGEN_FLAG) return Invocation.Complete({ words: rest });

  const rootPath = [cli.name];
  if (first !== undefined && ROOT_ACTION_FLAGS.includes(first)) {
    if (rest.length > 0) {
      return Invocation.UsageError({ message: `${first} takes nothing after it.`, node: cli.commands, path: rootPath });
    }
    return first === VERSION_FLAG ? Invocation.Version()
      : first === SET_UP_COMPLETION_FLAG ? Invocation.SetUpCompletion()
      : Invocation.RemoveCompletion();
  }

  let node: Node = cli.commands;
  const path = [...rootPath];
  let index = 0;
  while (!isCommand(node)) {
    const word = words[index];
    if (word === undefined) return Invocation.Help({ node, path });
    if (HELP_FLAGS.includes(word)) return Invocation.Help({ node, path });
    if (word.startsWith("-")) {
      const message = isChoice(node)
        ? `Expected a value after '${path.join(" ")}', got the flag '${word}'. Flags go after the command.`
        : `Unknown flag '${word}' for '${path.join(" ")}'. Flags go after the command.`;
      return Invocation.UsageError({ message, node, path });
    }
    const maybeChild = descend(node, word);
    if (Option.isNone(maybeChild)) {
      return Invocation.UsageError({ message: `Unknown command '${word}' for '${path.join(" ")}'.`, node, path });
    }
    node = maybeChild.value;
    path.push(word);
    index++;
  }

  const command = node;
  const maybeInvalid = invalidFlagNames(command);
  if (Option.isSome(maybeInvalid)) return Invocation.InvalidDefinition({ message: maybeInvalid.value });

  const flags: Record<string, FlagValue> = {};
  const given = new Set<string>();
  const args: Array<string> = [];
  const remaining = words.slice(index);
  for (let i = 0; i < remaining.length; i++) {
    const word = remaining[i]!;
    if (word === END_OF_FLAGS) {
      args.push(...remaining.slice(i + 1));
      break;
    }
    if (HELP_FLAGS.includes(word)) return Invocation.Help({ node: command, path });
    if (!word.startsWith("-") || word === "-") {
      args.push(word);
      continue;
    }

    const usageError = (message: string) => Invocation.UsageError({ message, node: command, path });
    if (!word.startsWith("--")) return usageError(`Unknown flag '${word}' for '${path.join(" ")}'.`);
    const equals = word.indexOf("=");
    const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
    if (!Object.hasOwn(command.flags, name)) return usageError(`Unknown flag '--${name}' for '${path.join(" ")}'.`);
    if (given.has(name)) return usageError(`--${name} was given more than once.`);
    given.add(name);

    const flag = command.flags[name]!;
    if (flag._tag === "BooleanFlag") {
      if (equals !== -1) return usageError(`--${name} takes no value.`);
      flags[name] = true;
      continue;
    }
    if (equals !== -1) {
      flags[name] = Option.some(word.slice(equals + 1));
      continue;
    }
    const value = remaining[i + 1];
    if (value === undefined || value.startsWith("-")) {
      return usageError(`--${name} needs a value: --${name} <value> or --${name}=<value>.`);
    }
    flags[name] = Option.some(value);
    i++;
  }

  const declared: FlagSet = command.flags;
  for (const [name, flag] of Object.entries(declared)) {
    if (!given.has(name)) flags[name] = flag._tag === "BooleanFlag" ? false : Option.none();
  }
  return Invocation.Execute({ command, path, flags, args });
}

/** The node one word leads to from a group or a choice. */
export function descend(node: Group | Choice<any, any>, word: string): Option.Option<Node> {
  if (isChoice(node)) return Option.some(node.next(word));
  // Own keys only: a plain object inherits `constructor`, `toString` and the rest, none of them commands.
  return Object.hasOwn(node, word) ? Option.some(node[word]!) : Option.none();
}

/** A flag name that could never be typed, or that `--help` would shadow, is a mistake in the CLI itself. */
function invalidFlagNames(command: Command<any, any, any>): Option.Option<string> {
  const invalid = Object.keys(command.flags).filter((name) => name === "help" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name));
  return invalid.length === 0
    ? Option.none()
    : Option.some(`Invalid flag names: ${invalid.join(", ")}. A flag name is letters, digits, '-' and '_', and 'help' is reserved.`);
}
