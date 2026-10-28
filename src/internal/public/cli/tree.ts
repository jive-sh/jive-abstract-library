import { Effect, Option } from "effect";

/**
 * What a CLI is made of: groups of named subcommands, choices whose values are listed at run time, and the
 * commands that run. A CLI author builds the tree with the constructors here; the parser, help and Tab
 * completion all walk the same tree, so what Tab offers is always what the parser accepts.
 *
 * Every piece an author writes that does work (a command's `run`, a choice's or a flag's `choices`) is a
 * generator function in Effect's own shape, the one `Effect.gen` takes, so the errors and services it needs are
 * inferred from what it yields and carried up the tree to `Cli.run`'s type.
 */

/** Any effect a generator may yield. */
type AnyEffect = Effect.Effect<any, any, any>;

type ErrorOf<Eff> = [Eff] extends [never] ? never : [Eff] extends [Effect.Effect<infer _A, infer E, infer _R>] ? E : never;
type ServicesOf<Eff> = [Eff] extends [never] ? never : [Eff] extends [Effect.Effect<infer _A, infer _E, infer R>] ? R : never;

/** Lists the values Tab offers at one position. Runs on every Tab press, and for a choice also in its help. */
export type ListChoices = () => Generator<AnyEffect, ReadonlyArray<string>, never>;

export class BooleanFlag {
  readonly _tag = "BooleanFlag";
  constructor(readonly description: Option.Option<string>) {}
}

export class StringFlag<R> {
  readonly _tag = "StringFlag";
  declare readonly _R: R;
  constructor(readonly description: Option.Option<string>, readonly choices: Option.Option<ListChoices>) {}
}

export type Flag = BooleanFlag | StringFlag<any>;
export type FlagSet = { readonly [name: string]: Flag };

/** The parsed value of each declared flag: whether a boolean flag was given, and a string flag's value if it was. */
export type FlagValues<Flags extends FlagSet> = {
  readonly [K in keyof Flags]: Flags[K] extends BooleanFlag ? boolean : Option.Option<string>;
};

type FlagServices<Flags extends FlagSet> = {
  [K in keyof Flags]: Flags[K] extends StringFlag<any> ? Flags[K]["_R"] : never;
}[keyof Flags];

/** What a command's `run` receives. */
export interface CommandInput<Flags extends FlagSet> {
  readonly flags: FlagValues<Flags>;
  /** The words after the command that are not flags, including everything after `--`. Never checked. */
  readonly args: ReadonlyArray<string>;
}

/**
 * A command that runs. `E` is what its `run` can fail with; `R` is the services its `run` and its flags'
 * `choices` need.
 */
export class Command<Flags extends FlagSet, E, R> {
  readonly _tag = "Command";
  declare readonly _E: E;
  declare readonly _R: R;
  constructor(
    readonly description: Option.Option<string>,
    readonly flags: Flags,
    readonly run: (input: CommandInput<Flags>) => Generator<AnyEffect, void, never>,
  ) {}
}

/**
 * One word whose possible values are listed at run time, followed by whatever `next` builds for the value
 * given. `E` and `R` are those of the subtree after it, plus the services its `choices` needs; a failing
 * `choices` never fails the CLI (help and Tab report it instead), so its errors are not part of `E`.
 */
export class Choice<E, R> {
  readonly _tag = "Choice";
  declare readonly _E: E;
  declare readonly _R: R;
  constructor(
    readonly description: Option.Option<string>,
    readonly choices: ListChoices,
    readonly next: (value: string) => Node,
  ) {}
}

/** A plain object naming its subcommands. */
export interface Group {
  readonly [name: string]: Node;
}

export type Node = Command<any, any, any> | Choice<any, any> | Group;

// Read through the phantom fields rather than with `infer`, which infers `unknown` from a field typed `never`.
export type NodeErrors<N> = N extends Command<any, any, any> | Choice<any, any> ? N["_E"]
  : N extends Group ? NodeErrors<N[keyof N]>
  : never;

export type NodeServices<N> = N extends Command<any, any, any> | Choice<any, any> ? N["_R"]
  : N extends Group ? NodeServices<N[keyof N]>
  : never;

/** A whole CLI: the name it is invoked by and its top-level commands. */
export class Cli<E, R> {
  declare readonly _E: E;
  declare readonly _R: R;
  constructor(readonly name: string, readonly commands: Group) {}
}

export function make<const Commands extends Group>(
  name: string,
  commands: Commands,
): Cli<NodeErrors<Commands>, NodeServices<Commands>> {
  return new Cli(name, commands);
}

export function choose<Eff extends AnyEffect, Next extends Node>(options: {
  readonly description?: string;
  choices(): Generator<Eff, ReadonlyArray<string>, never>;
  next(value: string): Next;
}): Choice<NodeErrors<NoInfer<Next>>, ServicesOf<NoInfer<Eff>> | NodeServices<NoInfer<Next>>> {
  return new Choice(
    Option.fromUndefinedOr(options.description),
    () => options.choices(),
    (value) => options.next(value),
  );
}

// The return types of `choose`, `command` and `flag.string` wrap their type parameters in NoInfer: inside `make`,
// the expected type of each subcommand is `Node`, whose `any`s would otherwise be inferred, erasing them.
export function command<const Flags extends FlagSet = {}, Eff extends AnyEffect = never>(options: {
  readonly description?: string;
  readonly flags?: Flags;
  run(input: CommandInput<Flags>): Generator<Eff, void, never>;
}): Command<NoInfer<Flags>, ErrorOf<NoInfer<Eff>>, ServicesOf<NoInfer<Eff>> | FlagServices<NoInfer<Flags>>> {
  return new Command(
    Option.fromUndefinedOr(options.description),
    options.flags ?? ({} as Flags),
    (input) => options.run(input),
  );
}

export const flag = {
  /** A flag given alone, `--shallow`. Its value is whether it was given. */
  boolean: (options: { readonly description?: string } = {}): BooleanFlag =>
    new BooleanFlag(Option.fromUndefinedOr(options.description)),
  /**
   * A flag with a value, `--branch main` or `--branch=main`. Its value is `Option.none()` when not given. With
   * `choices`, Tab after the flag offers what it lists.
   */
  string: <Eff extends AnyEffect = never>(options: {
    readonly description?: string;
    choices?(): Generator<Eff, ReadonlyArray<string>, never>;
  } = {}): StringFlag<ServicesOf<NoInfer<Eff>>> => {
    const { choices } = options;
    return new StringFlag(
      Option.fromUndefinedOr(options.description),
      choices === undefined ? Option.none() : Option.some(() => choices.call(options)),
    );
  },
};

export function isCommand(node: Node): node is Command<any, any, any> {
  return node instanceof Command;
}

export function isChoice(node: Node): node is Choice<any, any> {
  return node instanceof Choice;
}

/** What running a CLI can fail with, from its commands' `run`. */
export type Errors<C> = C extends Cli<any, any> ? C["_E"] : never;
/** The services a CLI's commands and choices need. */
export type Services<C> = C extends Cli<any, any> ? C["_R"] : never;
