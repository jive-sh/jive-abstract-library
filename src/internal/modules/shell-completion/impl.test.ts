import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Result, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { libraryModules, type LibraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import { ShellCompletionImpl } from "./impl";
import { MissingCompletion, type IShellCompletion } from "./interface";
import { completionScript } from "./scripts";

/** Runs setUp or remove against a fresh, fake home with the given environment. */
function inHome(home: string, env: Record<string, string>, os = "linux") {
  const osPlatform = OSPlatformImpl.mockLayer({
    *readEnv(name: string) { return Option.fromUndefinedOr(env[name]); },
    *getHomeDirectory() { return home; },
    *getCurrentPlatform() { return { os, cpu: "x64" }; },
  });
  const layer = pipe(ShellCompletionImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer));
  const run = <A>(change: (module: IShellCompletion) => EffectGen<A, string>) => Effect.runPromise(pipe(
    Effect.result(effunct(function* (): EffectGen<A, string, LibraryModules.ShellCompletion> {
      return yield* change(yield* libraryModules.ShellCompletion);
    })()),
    Effect.provide(layer),
  ));
  return {
    setUp: (name = "jive") => run((module) => module.setUp(name)),
    remove: (name = "jive") => run((module) => module.remove(name)),
    setUpIfMissing: (name = "jive") => run((module) => module.setUpIfMissing(name)),
  };
}

const freshHome = () => mkdtempSync(join(tmpdir(), "shell-completion-home-"));

describe("setting up and removing Tab completion", () => {
  test("zsh: writes the script under ~/.jive and a guarded line in .zshrc, keeping what was there", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    const { setUp, remove } = inHome(home, { SHELL: "/bin/zsh" });

    const script = join(home, ".jive", "completions", "jive.zsh");
    expect(await setUp()).toEqual(Result.succeed({ shell: "zsh", scriptPath: script, startupFile: Option.some(join(home, ".zshrc")) }));
    expect(readFileSync(script, "utf-8")).toBe(completionScript("zsh", "jive"));
    const block = `# begin jive completion\n[ -f '${script}' ] && . '${script}'\n# end jive completion\n`;
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(`export EDITOR=vim\n\n${block}`);

    // A second setup replaces the block instead of adding another.
    await setUp();
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(`export EDITOR=vim\n\n${block}`);

    expect(Result.isSuccess(await remove())).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("export EDITOR=vim\n");
    expect(existsSync(script)).toBe(false);
  });

  test("zsh: honours ZDOTDIR", async () => {
    const home = freshHome();
    const zdotdir = mkdtempSync(join(tmpdir(), "zdotdir-"));
    await inHome(home, { SHELL: "/usr/bin/zsh", ZDOTDIR: zdotdir }).setUp();
    expect(readFileSync(join(zdotdir, ".zshrc"), "utf-8")).toContain("# begin jive completion");
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  test("bash: .bash_profile on macOS, .bashrc elsewhere, created when missing", async () => {
    const mac = freshHome();
    await inHome(mac, { SHELL: "/bin/bash" }, "darwin").setUp();
    expect(readFileSync(join(mac, ".bash_profile"), "utf-8")).toContain(join(mac, ".jive", "completions", "jive.bash"));
    const linux = freshHome();
    await inHome(linux, { SHELL: "/usr/bin/bash" }, "linux").setUp();
    expect(readFileSync(join(linux, ".bashrc"), "utf-8")).toContain(join(linux, ".jive", "completions", "jive.bash"));
  });

  test("fish: writes into fish's own completions directory and touches no startup file", async () => {
    const home = freshHome();
    const { setUp, remove } = inHome(home, { SHELL: "/opt/homebrew/bin/fish" });
    const script = join(home, ".config", "fish", "completions", "jive.fish");
    expect(await setUp()).toEqual(Result.succeed({ shell: "fish", scriptPath: script, startupFile: Option.none() }));
    expect(readFileSync(script, "utf-8")).toBe(completionScript("fish", "jive"));
    await remove();
    expect(existsSync(script)).toBe(false);
  });

  test("removing what was never set up changes nothing and succeeds", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".zshrc"), "untouched\n");
    expect(Result.isSuccess(await inHome(home, { SHELL: "/bin/zsh" }).remove())).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("untouched\n");
  });

  test("refuses an unknown or missing shell, and a name a shell cannot complete", async () => {
    const home = freshHome();
    expect(await inHome(home, { SHELL: "/usr/bin/nu" }).setUp()).toEqual(Result.fail("Tab completion supports bash, zsh, fish; SHELL is /usr/bin/nu."));
    expect(await inHome(home, {}).setUp()).toEqual(Result.fail("SHELL is not set, so there is no shell to set up."));
    expect(await inHome(home, { SHELL: "/bin/zsh" }).setUp("a b")).toEqual(Result.fail("'a b' is not a command name a shell can complete."));
  });

  test("setting up when missing: only when missing, never after it was turned off, never for an unknown shell", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    const { setUpIfMissing, setUp, remove } = inHome(home, { SHELL: "/bin/zsh" });
    const files = { shell: "zsh", scriptPath: join(home, ".jive", "completions", "jive.zsh"), startupFile: Option.some(join(home, ".zshrc")) } as const;

    expect(await setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.SetUp({ files })));
    const afterSetUp = readFileSync(join(home, ".zshrc"), "utf-8");
    expect(await setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.AlreadySetUp()));
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(afterSetUp);

    // The line removed by hand while the script stays: missing again.
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    expect(await setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.SetUp({ files })));

    await remove();
    expect(await setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.TurnedOff()));
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("export EDITOR=vim\n");
    await setUp();
    expect(await setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.AlreadySetUp()));

    expect(await inHome(freshHome(), { SHELL: "/usr/bin/nu" }).setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.UnsupportedShell()));
    expect(await inHome(freshHome(), {}).setUpIfMissing()).toEqual(Result.succeed(MissingCompletion.UnsupportedShell()));
  });
});
