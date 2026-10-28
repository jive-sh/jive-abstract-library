import { describe, expect, test } from "bun:test";
import { Context, Data, Effect, Exit, Layer, Option, Sink, Stdio, pipe } from "effect";
import { TestConsole } from "effect/testing";
import * as Cli from "./index";

/** A fake of the services a real CLI's choices and commands would call, recording what was run. */
class RepoListError extends Data.TaggedError("RepoListError")<{ readonly message: string }> {}
class CloneError extends Data.TaggedError("CloneError")<{ readonly message: string }> {}

interface IRepos {
  orgs(): Effect.fn.Return<ReadonlyArray<string>>;
  repos(org: string): Effect.fn.Return<ReadonlyArray<string>, RepoListError>;
  branches(org: string, repo: string): Effect.fn.Return<ReadonlyArray<string>>;
  load(input: { org: string; repo: string; shallow: boolean; branch: Option.Option<string> }): Effect.fn.Return<void, CloneError>;
}
class Repos extends Context.Service<Repos, IRepos>()("Repos") {}

function fakeRepos(loaded: Array<unknown>): IRepos {
  return {
    *orgs() { return ["chaine-dance", "jive-sh"]; },
    *repos(org) {
      if (org === "offline") return yield* new RepoListError({ message: "GitHub is unreachable" });
      return org === "jive-sh" ? ["jive", "jive-abstract-library", "server"] : ["chaine"];
    },
    *branches(_org, _repo) { return ["main", "maintenance", "release"]; },
    *load(input) {
      if (input.repo === "broken") return yield* new CloneError({ message: "clone failed" });
      loaded.push(input);
    },
  };
}

const jive = Cli.make("jive", {
  load: Cli.choose({
    description: "Clone a repo into the workspace",
    *choices() { return yield* (yield* Repos).orgs(); },
    next: (org) => Cli.choose({
      *choices() { return yield* (yield* Repos).repos(org); },
      next: (repo) => Cli.command({
        description: `Clone ${org}/${repo}`,
        flags: {
          shallow: Cli.flag.boolean({ description: "Clone without history" }),
          branch: Cli.flag.string({
            description: "Branch to check out",
            *choices() { return yield* (yield* Repos).branches(org, repo); },
          }),
        },
        *run({ flags, args }) {
          const typed: { readonly shallow: boolean; readonly branch: Option.Option<string> } = flags;
          yield* (yield* Repos).load({ org, repo, ...typed });
          if (args.length > 0) yield* (yield* Repos).load({ org: "args", repo: args.join(" "), shallow: false, branch: Option.none() });
        },
      }),
    }),
  }),
  provision: {
    package: Cli.command({ *run() {} }),
  },
});

// The types the tree infers, exactly (an `any` would pass a plain assignment): `run`'s failures, and every
// service the tree's generators yield.
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Ran = ReturnType<typeof Cli.run<Cli.Errors<typeof jive>, Cli.Services<typeof jive>>>;
const errorsAreExact: Equals<Ran extends Effect.Effect<any, infer E, any> ? E : never, CloneError | Cli.CliError> = true;
const servicesAreExact: Equals<Ran extends Effect.Effect<any, any, infer R> ? R : never, Repos | Stdio.Stdio> = true;
void [errorsAreExact, servicesAreExact];

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: Exit.Exit<void, unknown>;
  readonly loaded: ReadonlyArray<unknown>;
}

async function invoke(args: ReadonlyArray<string>): Promise<Outcome> {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const loaded: Array<unknown> = [];
  const collect = (into: Array<string>) => () =>
    Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => { into.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)); }));
  const exit = await Effect.runPromise(pipe(
    Cli.run(jive, { version: "1.2.3" }),
    Effect.provide(Layer.mergeAll(
      Stdio.layerTest({ args: Effect.succeed(args), stdout: collect(stdout), stderr: collect(stderr) }),
      Layer.succeed(Repos, fakeRepos(loaded)),
    )),
    Effect.exit,
  ));
  return { stdout: stdout.join(""), stderr: stderr.join(""), exit, loaded };
}

const exitCodeOf = (exit: Exit.Exit<void, unknown>) =>
  Exit.isSuccess(exit) ? 0 : Option.match(Exit.findErrorOption(exit), {
    onNone: () => -1,
    onSome: (error) => error instanceof Cli.CliError ? error.exitCode : 1,
  });

describe("running a command", () => {
  test("follows choices to the command and passes typed flags and the remaining words", async () => {
    const { exit, loaded } = await invoke(["load", "jive-sh", "server", "--shallow", "--branch", "release", "extra", "--", "--not-a-flag"]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(loaded).toEqual([
      { org: "jive-sh", repo: "server", shallow: true, branch: Option.some("release") },
      { org: "args", repo: "extra --not-a-flag", shallow: false, branch: Option.none() },
    ]);
  });

  test("gives flags that were not given their empty values, and reads --flag=value", async () => {
    expect((await invoke(["load", "a", "b"])).loaded).toEqual([{ org: "a", repo: "b", shallow: false, branch: Option.none() }]);
    expect((await invoke(["load", "a", "b", "--branch=x"])).loaded).toEqual([{ org: "a", repo: "b", shallow: false, branch: Option.some("x") }]);
  });

  test("accepts a value its choices would not list: they are suggestions for Tab", async () => {
    expect((await invoke(["load", "someone-else", "anything"])).loaded).toHaveLength(1);
  });

  test("fails with what the command's run failed with", async () => {
    const { exit } = await invoke(["load", "a", "broken"]);
    expect(Exit.findErrorOption(exit)).toEqual(Option.some(new CloneError({ message: "clone failed" })));
  });

  test("runs a command inside a plain group", async () => {
    expect(Exit.isSuccess((await invoke(["provision", "package"])).exit)).toBe(true);
  });
});

describe("usage errors", () => {
  for (const [args, message] of [
    [["lod"], "Unknown command 'lod' for 'jive'."],
    [["constructor"], "Unknown command 'constructor' for 'jive'."],
    [["load", "--shallow"], "Expected a value after 'jive load', got the flag '--shallow'. Flags go after the command."],
    [["load", "a", "b", "--depth"], "Unknown flag '--depth' for 'jive load a b'."],
    [["load", "a", "b", "-s"], "Unknown flag '-s' for 'jive load a b'."],
    [["load", "a", "b", "--branch"], "--branch needs a value: --branch <value> or --branch=<value>."],
    [["load", "a", "b", "--branch", "--shallow"], "--branch needs a value: --branch <value> or --branch=<value>."],
    [["load", "a", "b", "--shallow=yes"], "--shallow takes no value."],
    [["load", "a", "b", "--shallow", "--shallow"], "--shallow was given more than once."],
    [["--version", "x"], "--version takes nothing after it."],
  ] as const) {
    test(`${args.join(" ")}: ${message}`, async () => {
      const { stdout, stderr, exit, loaded } = await invoke(args);
      expect(stderr.startsWith(`${message}\n\nUsage: `)).toBe(true);
      expect(stdout).toBe("");
      expect(exitCodeOf(exit)).toBe(2);
      expect(loaded).toEqual([]);
    });
  }
});

describe("help and version", () => {
  test("the root lists its commands and the library's own flags", async () => {
    const { stdout, exit } = await invoke(["--help"]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stdout).toBe([
      "Usage: jive <command>",
      "",
      "Commands:",
      "  load        Clone a repo into the workspace",
      "  provision",
      "",
      "Flags:",
      "  --help, -h            Show this help",
      "  --version             Print the version",
      "  --setup-completion    Turn on Tab completion for jive in your shell",
      "  --remove-completion   Turn off Tab completion for jive in your shell",
      "",
    ].join("\n"));
  });

  test("no words at all shows the root's help", async () => {
    expect((await invoke([])).stdout).toBe((await invoke(["-h"])).stdout);
  });

  test("a choice's help lists what its choices returns", async () => {
    expect((await invoke(["load", "jive-sh", "--help"])).stdout).toBe([
      "Usage: jive load jive-sh <choice>",
      "",
      "Choices:",
      "  jive",
      "  jive-abstract-library",
      "  server",
      "",
    ].join("\n"));
  });

  test("a choice whose choices fails still shows its help, with the failure", async () => {
    const { stdout, exit } = await invoke(["load", "offline"]);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(stdout).toContain("Choices: could not be listed: GitHub is unreachable");
  });

  test("a command's help lists its flags", async () => {
    expect((await invoke(["load", "jive-sh", "server", "--help"])).stdout).toBe([
      "Usage: jive load jive-sh server [flags]",
      "",
      "Clone jive-sh/server",
      "",
      "Flags:",
      "  --shallow          Clone without history",
      "  --branch <value>   Branch to check out",
      "  --help, -h         Show this help",
      "",
    ].join("\n"));
  });

  test("--version prints the version given to run", async () => {
    expect((await invoke(["--version"])).stdout).toBe("1.2.3\n");
  });
});

describe("Tab completion (--compgen)", () => {
  const completes = async (...words: Array<string>) => {
    const { stdout, stderr, exit } = await invoke(["--compgen", ...words]);
    expect(Exit.isSuccess(exit)).toBe(true);
    return { lines: stdout.split("\n").filter((line) => line !== ""), stderr };
  };

  test("offers a group's subcommands with their descriptions", async () => {
    expect((await completes("")).lines).toEqual(["load\tClone a repo into the workspace", "provision"]);
    expect((await completes("pro")).lines).toEqual(["provision"]);
    expect((await completes("provision", "")).lines).toEqual(["package"]);
  });

  test("runs a choice's choices for the word being completed", async () => {
    expect((await completes("load", "")).lines).toEqual(["chaine-dance", "jive-sh"]);
    expect((await completes("load", "jive-sh", "jive")).lines).toEqual(["jive", "jive-abstract-library"]);
  });

  test("offers a command's unused flags once a '-' is typed, and nothing before", async () => {
    expect((await completes("load", "a", "b", "")).lines).toEqual([]);
    expect((await completes("load", "a", "b", "--shallow", "-")).lines).toEqual(["--branch\tBranch to check out", "--help\tShow this help"]);
  });

  test("runs a string flag's choices for its value", async () => {
    expect((await completes("load", "jive-sh", "server", "--branch", "ma")).lines).toEqual(["main", "maintenance"]);
    expect((await completes("load", "jive-sh", "server", "--branch", "main", "--shallow", "")).lines).toEqual([]);
  });

  test("offers the root's own flags at the root", async () => {
    expect((await completes("--")).lines).toEqual(["--help", "--version", "--setup-completion", "--remove-completion"]);
  });

  test("a failing choices offers nothing and reports why on stderr", async () => {
    const { lines, stderr } = await completes("load", "offline", "");
    expect(lines).toEqual([]);
    expect(stderr).toBe("\njive: could not list choices: GitHub is unreachable\n");
  });

  test("offers nothing after --, after an unknown word, or for a --flag=value", async () => {
    expect((await completes("load", "a", "b", "--", "")).lines).toEqual([]);
    expect((await completes("nope", "")).lines).toEqual([]);
    expect((await completes("load", "a", "b", "--branch=m")).lines).toEqual([]);
  });

  test("logs nothing while listing, since a logger may share stdout with the candidates", async () => {
    const noisy = Cli.make("noisy", {
      pick: Cli.choose({ *choices() { yield* Effect.log("listing"); return ["x"]; }, next: () => Cli.command({ *run() {} }) }),
    });
    const stdout: Array<string> = [];
    const logged = await Effect.runPromise(pipe(
      Cli.run(noisy, { version: "0" }),
      Effect.andThen(TestConsole.logLines),
      Effect.provide(Stdio.layerTest({
        args: Effect.succeed(["--compgen", "pick", ""]),
        stdout: () => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => { stdout.push(String(chunk)); })),
      })),
      Effect.provide(TestConsole.layer),
    ));
    expect(stdout.join("")).toBe("x\n");
    expect(logged).toEqual([]);
  });
});

test("a flag named help is a mistake in the CLI, not in what was typed", async () => {
  const wrong = Cli.make("wrong", { go: Cli.command({ flags: { help: Cli.flag.boolean() }, *run() {} }) });
  const exit = await Effect.runPromise(pipe(
    Cli.run(wrong, { version: "0" }),
    Effect.provide(Stdio.layerTest({ args: Effect.succeed(["go"]) })),
    Effect.exit,
  ));
  expect(Exit.hasDies(exit)).toBe(true);
});
