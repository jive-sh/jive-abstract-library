import { Effect, Option, Result } from "effect";
import { listChoices } from "./choices";
import { nodeDescription } from "./help";
import { HELP_FLAGS, REMOVE_COMPLETION_FLAG, SET_UP_COMPLETION_FLAG, VERSION_FLAG, descend } from "./parse";
import { isChoice, isCommand, type Cli, type Command, type Flag, type FlagSet, type ListChoices, type Node } from "./tree";

/**
 * What Tab offers, given the words typed after the CLI's name up to the cursor, the last one being the word
 * being completed ("" right after a space). It walks the tree the way the parser does, so it offers only what
 * the parser would accept there: a group's subcommands, a choice's listed values, a command's flags once a
 * `-` is typed, and a string flag's listed values right after the flag.
 *
 * Offers are filtered to those starting with the word being completed, so every shell gets the same list.
 */

export interface Candidate {
  readonly value: string;
  readonly description: Option.Option<string>;
}

export interface Completion {
  readonly candidates: ReadonlyArray<Candidate>;
  /** Why a listing failed, for the shell to show; the candidates are then whatever else applied. */
  readonly failure: Option.Option<string>;
}

const NOTHING: Completion = { candidates: [], failure: Option.none() };

export function complete(cli: Cli<any, any>, words: ReadonlyArray<string>): Effect.Effect<Completion, never, any> {
  const current = words.length === 0 ? "" : words[words.length - 1]!;
  const typed = words.slice(0, -1);

  let node: Node = cli.commands;
  let index = 0;
  while (!isCommand(node) && index < typed.length) {
    const word = typed[index]!;
    if (word.startsWith("-")) return Effect.succeed(NOTHING);
    const maybeChild = descend(node, word);
    if (Option.isNone(maybeChild)) return Effect.succeed(NOTHING);
    node = maybeChild.value;
    index++;
  }

  const filtered = (completion: Completion): Completion => ({
    ...completion,
    candidates: completion.candidates.filter((candidate) => candidate.value.startsWith(current)),
  });

  if (isCommand(node)) return Effect.map(completeCommand(node, typed.slice(index), current), filtered);
  if (isChoice(node)) return Effect.map(fromChoices(node.choices), filtered);

  const group = node;
  const subcommands = Object.keys(group).sort().map((name) => ({ value: name, description: nodeDescription(group[name]!) }));
  const flags = current.startsWith("-")
    ? [...HELP_FLAGS, ...(node === cli.commands ? [VERSION_FLAG, SET_UP_COMPLETION_FLAG, REMOVE_COMPLETION_FLAG] : [])]
      .map((value) => ({ value, description: Option.none<string>() }))
    : [];
  return Effect.succeed(filtered({ candidates: [...subcommands, ...flags], failure: Option.none() }));
}

function completeCommand(command: Command<any, any, any>, typed: ReadonlyArray<string>, current: string): Effect.Effect<Completion, never, any> {
  const flags: FlagSet = command.flags;
  const given = new Set<string>();
  for (let i = 0; i < typed.length; i++) {
    const word = typed[i]!;
    if (word === "--") return Effect.succeed(NOTHING);
    if (!word.startsWith("--")) continue;
    const name = word.includes("=") ? word.slice(2, word.indexOf("=")) : word.slice(2);
    given.add(name);
    const flag = Object.hasOwn(flags, name) ? Option.some(flags[name]!) : Option.none<Flag>();
    const takesNextWord = Option.isSome(flag) && flag.value._tag === "StringFlag" && !word.includes("=");
    if (!takesNextWord) continue;
    if (i === typed.length - 1) {
      // The word being completed is this flag's value.
      return flag.value._tag === "StringFlag" && Option.isSome(flag.value.choices)
        ? fromChoices(flag.value.choices.value)
        : Effect.succeed(NOTHING);
    }
    i++;
  }

  // A value typed as --flag=value is not completed, and neither is anything else that is not a flag.
  if (!current.startsWith("-") || current.includes("=")) return Effect.succeed(NOTHING);
  const unused = Object.entries(flags)
    .filter(([name]) => !given.has(name))
    .map(([name, flag]) => ({ value: `--${name}`, description: flag.description }));
  return Effect.succeed({
    candidates: [...unused, { value: HELP_FLAGS[0]!, description: Option.some("Show this help") }],
    failure: Option.none(),
  });
}

function fromChoices(choices: ListChoices): Effect.Effect<Completion, never, any> {
  return Effect.map(listChoices(choices), (listed) => Result.isSuccess(listed)
    ? { candidates: listed.success.map((value) => ({ value, description: Option.none<string>() })), failure: Option.none() }
    : { candidates: [], failure: Option.some(listed.failure) });
}

/**
 * The reply to the shell: one candidate per line, a tab before its description. The scripts the shells
 * load (see `shell-completion/scripts.ts`) read exactly this; anything else on stdout would be offered as a
 * candidate too.
 */
export function formatCompletion(candidates: ReadonlyArray<Candidate>): string {
  return candidates
    .map(({ value, description }) => Option.match(description, {
      onNone: () => value,
      onSome: (text) => `${value}\t${text.replace(/\s+/g, " ")}`,
    }))
    .map((line) => `${line}\n`)
    .join("");
}
