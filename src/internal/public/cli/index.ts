/**
 * Building a command-line interface whose Tab completion is computed when Tab is pressed.
 *
 * A CLI is a tree: plain objects name subcommands, `choose` is one word whose values its `choices` lists at
 * run time (Tab calls the CLI itself with `--compgen`, which runs the same `choices`), and `command` is what
 * runs, with its flags typed from their declarations. `run` reads the arguments and does what they say; the
 * root also answers `--help`, `--version`, `--setup-completion` and `--remove-completion`.
 *
 * ```ts
 * const jive = Cli.make("jive", {
 *   load: Cli.choose({
 *     description: "Clone a repo into the workspace",
 *     *choices() { return yield* git.localOrgs(); },
 *     next: (org) => Cli.command({
 *       flags: { shallow: Cli.flag.boolean({ description: "Clone without history" }) },
 *       *run({ flags }) { yield* workspace.load({ org, shallow: flags.shallow }); },
 *     }),
 *   }),
 * });
 * BunRuntime.runMain(pipe(Cli.run(jive, { version }), Effect.provide(AppLayer), Effect.provide(Cli.terminalLogger), Effect.provide(BunServices.layer)));
 * ```
 */
export { make, choose, command, flag, type Cli, type Choice, type Command, type CommandInput, type Errors, type FlagValues, type Services, type Group, type Node } from "./tree";
export { run, CliError } from "./run";
export { terminalLogger } from "../../common/logger";
