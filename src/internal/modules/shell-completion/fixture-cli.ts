/**
 * A small CLI built with `Cli`, run as a real process by the shell tests: the shell's completion script calls
 * it with `--compgen` exactly as it would call an installed command. Its choices come from argument-free
 * generators, so it reaches nothing outside this process.
 */
import { Effect, pipe } from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import * as Cli from "../../public/cli";

const fixture = Cli.make("fixturecli", {
  load: Cli.choose({
    description: "Clone a repo",
    *choices() { return yield* Effect.succeed(["chaine-dance", "jive-sh"]); },
    next: (org) => Cli.command({
      flags: {
        shallow: Cli.flag.boolean({ description: "Clone without history" }),
        branch: Cli.flag.string({ *choices() { return [`${org}-main`, `${org}-next`]; } }),
      },
      *run() {},
    }),
  }),
  provision: { package: Cli.command({ description: "Provision a package", *run() {} }) },
});

BunRuntime.runMain(pipe(Cli.run(fixture, { version: "0.0.0" }), Effect.provide(BunServices.layer)));
