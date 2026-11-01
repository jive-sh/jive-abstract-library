import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, Option, Result, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { libraryModules, type LibraryModules } from "../index";
import type { ProcessResult, SpawnProcessInput } from "../os-platform/interface";
import { OSPlatformImpl } from "../os-platform/impl";
import { ShellCompletionImpl } from "./impl";
import { MissingCompletion, type IShellCompletion } from "./interface";
import { startupBlock } from "./scripts";

interface Machine {
  readonly env?: Record<string, string>;
  readonly os?: string;
  /** What `findExecutable` finds, by command name; a `searchPath` lookup sees only names whose path is in it. */
  readonly executables?: Record<string, string>;
  /** This process's own executable. */
  readonly executablePath?: string;
  /** Answers to `spawnProcess`, by command. */
  readonly answers?: Record<string, ProcessResult>;
}

/** Runs the real module against a fresh home and a fake host, recording every process it starts. */
function onMachine(home: string, machine: Machine = {}) {
  const env = machine.env ?? {};
  const spawned: Array<SpawnProcessInput> = [];
  const osPlatform = OSPlatformImpl.mockLayer({
    *readEnv(name: string) { return Option.fromUndefinedOr(env[name]); },
    *getHomeDirectory() { return home; },
    *getCurrentPlatform() { return { os: machine.os ?? "linux", cpu: "x64" }; },
    *getExecutablePath() { return machine.executablePath ?? "/nowhere/self"; },
    *findExecutable(command: string, options?: { readonly searchPath?: string }) {
      const found = machine.executables?.[command];
      if (found === undefined) return Option.none();
      const searchPath = options?.searchPath;
      const visible = searchPath === undefined || searchPath.split(":").some((dir) => found.startsWith(`${dir}/`));
      return visible ? Option.some(found) : Option.none();
    },
    *spawnProcess(input: SpawnProcessInput) {
      spawned.push(input);
      const answer = machine.answers?.[input.command];
      if (answer === undefined) return yield* Effect.fail(`Failed to run ${input.command}: not found`);
      return answer;
    },
  });
  const layer = pipe(ShellCompletionImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(BunFileSystem.layer));
  const run = <A>(change: (module: IShellCompletion) => EffectGen<A, string>) => Effect.runPromise(pipe(
    Effect.result(effunct(function* (): EffectGen<A, string, LibraryModules.ShellCompletion> {
      return yield* change(yield* libraryModules.ShellCompletion);
    })()),
    Effect.provide(layer),
  ));
  return {
    spawned,
    setUp: (name = "jive") => run((module) => module.setUp(name)),
    setUpMissing: (name = "jive") => run((module) => module.setUpMissing(name)),
    remove: (name = "jive") => run((module) => module.remove(name)),
  };
}

const freshHome = () => mkdtempSync(join(tmpdir(), "shell-completion-home-"));
const ZSH_LINE = `# begin jive completion\ncommand -v 'jive' >/dev/null 2>&1 && eval "$('jive' --completion zsh)"\n# end jive completion\n`;

describe("setting up and removing Tab completion", () => {
  test("zsh: one guarded line in .zshrc that evaluates the installed command's script, keeping what was there", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".zshrc"), "export EDITOR=vim\n");
    const { setUp, remove } = onMachine(home, { env: { SHELL: "/bin/zsh" } });

    expect(await setUp()).toEqual(Result.succeed({ shell: "zsh", files: [join(home, ".zshrc")], warnings: [] }));
    expect(startupBlock("zsh", "jive")).toBe(ZSH_LINE);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(`export EDITOR=vim\n\n${ZSH_LINE}`);

    // A second setup replaces the block instead of adding another.
    await setUp();
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(`export EDITOR=vim\n\n${ZSH_LINE}`);

    expect(Result.isSuccess(await remove())).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("export EDITOR=vim\n");
    expect(existsSync(join(home, ".jive", "completions", "jive.off"))).toBe(true);
    // Setting it up again clears the turned-off record.
    await setUp();
    expect(existsSync(join(home, ".jive", "completions", "jive.off"))).toBe(false);
  });

  test("zsh: honours ZDOTDIR", async () => {
    const home = freshHome();
    const zdotdir = mkdtempSync(join(tmpdir(), "zdotdir-"));
    await onMachine(home, { env: { SHELL: "/usr/bin/zsh", ZDOTDIR: zdotdir } }).setUp();
    expect(readFileSync(join(zdotdir, ".zshrc"), "utf-8")).toBe(ZSH_LINE);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  test("bash: .bash_profile on macOS, .bashrc elsewhere, created when missing", async () => {
    const mac = freshHome();
    await onMachine(mac, { env: { SHELL: "/bin/bash" }, os: "darwin" }).setUp();
    expect(readFileSync(join(mac, ".bash_profile"), "utf-8")).toBe(startupBlock("bash", "jive"));
    const linux = freshHome();
    await onMachine(linux, { env: { SHELL: "/usr/bin/bash" } }).setUp();
    expect(readFileSync(join(linux, ".bashrc"), "utf-8")).toBe(startupBlock("bash", "jive"));
  });

  test("fish: a file of its own in fish's completions directory, deleted on removal", async () => {
    const home = freshHome();
    const { setUp, remove } = onMachine(home, { env: { SHELL: "/opt/homebrew/bin/fish" } });
    const file = join(home, ".config", "fish", "completions", "jive.fish");
    expect(await setUp()).toEqual(Result.succeed({ shell: "fish", files: [file], warnings: [] }));
    expect(readFileSync(file, "utf-8")).toBe(`# begin jive completion\ncommand -q 'jive'; and 'jive' --completion fish | source\n# end jive completion\n`);
    await remove();
    expect(existsSync(file)).toBe(false);
  });

  test("PowerShell: each installed PowerShell's own profile, as it reports it, with a note when its policy stops profiles", async () => {
    const home = freshHome();
    const pwshProfile = join(home, "Documents", "PowerShell", "Profile.ps1");
    const windowsProfile = join(home, "OneDrive", "Documents", "WindowsPowerShell", "profile.ps1");
    const machine = onMachine(home, {
      os: "win32",
      executables: { pwsh: "C:/Program Files/PowerShell/7/pwsh.exe", powershell: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" },
      answers: {
        "C:/Program Files/PowerShell/7/pwsh.exe": { exitCode: 0, stdout: `${pwshProfile}\r\nRemoteSigned\r\n`, stderr: "" },
        "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe": { exitCode: 0, stdout: `${windowsProfile}\r\nRestricted\r\n`, stderr: "" },
      },
    });
    const setup = await machine.setUp();
    expect(setup).toEqual(Result.succeed({
      shell: "powershell",
      files: [pwshProfile, windowsProfile],
      warnings: [`powershell's execution policy is Restricted, which stops it running ${windowsProfile}; completion loads once it allows local scripts (Set-ExecutionPolicy -Scope CurrentUser RemoteSigned).`],
    }));
    for (const profile of [pwshProfile, windowsProfile]) expect(readFileSync(profile, "utf-8")).toBe(startupBlock("powershell", "jive"));
    expect(machine.spawned[0]!.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserAllHosts; Get-ExecutionPolicy"]);
  });

  test("PowerShell elsewhere: pwsh only, chosen when SHELL names it", async () => {
    const home = freshHome();
    const profile = join(home, ".config", "powershell", "profile.ps1");
    const setup = await onMachine(home, {
      env: { SHELL: "/usr/local/bin/pwsh" },
      executables: { pwsh: "/usr/local/bin/pwsh", powershell: "/usr/local/bin/powershell" },
      answers: { "/usr/local/bin/pwsh": { exitCode: 0, stdout: `${profile}\nUnrestricted\n`, stderr: "" } },
    }).setUp();
    expect(setup).toEqual(Result.succeed({ shell: "powershell", files: [profile], warnings: [] }));
  });

  test("removing what was never set up changes nothing and succeeds", async () => {
    const home = freshHome();
    writeFileSync(join(home, ".zshrc"), "untouched\n");
    expect(Result.isSuccess(await onMachine(home, { env: { SHELL: "/bin/zsh" } }).remove())).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe("untouched\n");
  });

  test("refuses an unknown or missing shell, a missing PowerShell, and a name a shell cannot complete", async () => {
    const home = freshHome();
    expect(await onMachine(home, { env: { SHELL: "/usr/bin/nu" } }).setUp())
      .toEqual(Result.fail("Tab completion supports bash, zsh, fish and PowerShell; SHELL is /usr/bin/nu."));
    expect(await onMachine(home).setUp()).toEqual(Result.fail("SHELL is not set, so there is no shell to set up."));
    expect(await onMachine(home, { os: "win32" }).setUp()).toEqual(Result.fail("No PowerShell is installed: looked for pwsh and powershell on PATH."));
    expect(await onMachine(home, { env: { SHELL: "/bin/zsh" } }).setUp("a b")).toEqual(Result.fail("'a b' is not a command name a shell can complete."));
  });
});

describe("setting up missing Tab completion", () => {
  /** A home whose user's PATH holds `jive` in `bin`, linked to this process's own executable. */
  function installedGlobally(extraEnv: Record<string, string> = {}) {
    const home = freshHome();
    const self = join(home, "lib", "node_modules", "jive-cli", "bin", "jive");
    mkdirSync(join(home, "lib", "node_modules", "jive-cli", "bin"), { recursive: true });
    writeFileSync(self, "");
    mkdirSync(join(home, "bin"));
    symlinkSync(self, join(home, "bin", "jive"));
    const env = { SHELL: "/bin/zsh", PATH: `${home}/project/node_modules/.bin:${home}/bin`, ...extraEnv };
    return { home, self, machine: (more: Machine = {}) => onMachine(home, { env, executables: { jive: join(home, "bin", "jive") }, executablePath: self, ...more }) };
  }

  test("sets it up when the copy on the user's PATH is this one, then finds it already set up", async () => {
    const { home, machine } = installedGlobally();
    const first = await machine().setUpMissing();
    expect(first).toEqual(Result.succeed(MissingCompletion.SetUp({ setup: { shell: "zsh", files: [join(home, ".zshrc")], warnings: [] } })));
    const second = machine();
    expect(await second.setUpMissing()).toEqual(Result.succeed(MissingCompletion.AlreadySetUp()));
    expect(second.spawned).toEqual([]);
  });

  test("replaces an older or commented-out block between the same markers", async () => {
    const { home, machine } = installedGlobally();
    writeFileSync(join(home, ".zshrc"), "# begin jive completion\n# . <(jive --completion)\n# end jive completion\n");
    expect(Result.isSuccess(await machine().setUpMissing())).toBe(true);
    expect(readFileSync(join(home, ".zshrc"), "utf-8")).toBe(ZSH_LINE);
  });

  test("a copy that is not the one on PATH asks that command which protocol it speaks", async () => {
    const home = freshHome();
    const env = { SHELL: "/bin/zsh", PATH: "/shims" };
    const ask = (stdout: string, exitCode = 0) => onMachine(home, {
      env,
      executables: { jive: "/shims/jive.cmd" },
      answers: { "/shims/jive.cmd": { exitCode, stdout, stderr: "" } },
    });
    const speaks = ask("1\n");
    expect(Result.isSuccess(await speaks.setUpMissing()) && existsSync(join(home, ".zshrc"))).toBe(true);
    expect(speaks.spawned.map((input) => [input.command, input.args, input.timeoutMs])).toEqual([["/shims/jive.cmd", ["--completion-protocol"], 5000]]);

    const other = freshHome();
    for (const answer of [{ stdout: "2\n" }, { stdout: "usage: jive …\n", exitCode: 2 }]) {
      const machine = onMachine(other, { env, executables: { jive: "/shims/jive.cmd" }, answers: { "/shims/jive.cmd": { exitCode: answer.exitCode ?? 0, stdout: answer.stdout, stderr: "" } } });
      expect(await machine.setUpMissing()).toEqual(Result.succeed(MissingCompletion.NotOnPath()));
    }
    expect(await onMachine(other, { env, executables: { jive: "/shims/jive.cmd" } }).setUpMissing())
      .toEqual(Result.succeed(MissingCompletion.NotOnPath()));
    expect(existsSync(join(other, ".zshrc"))).toBe(false);
  });

  test("a copy installed in a project, run through its package manager, sets nothing up", async () => {
    const home = freshHome();
    // The only `jive` is in the project's node_modules/.bin, which the package manager put first on PATH.
    const machine = onMachine(home, {
      env: { SHELL: "/bin/zsh", PATH: `${home}/project/node_modules/.bin:/usr/bin` },
      executables: { jive: `${home}/project/node_modules/.bin/jive` },
      answers: { [`${home}/project/node_modules/.bin/jive`]: { exitCode: 0, stdout: "1\n", stderr: "" } },
    });
    expect(await machine.setUpMissing()).toEqual(Result.succeed(MissingCompletion.NotOnPath()));
    expect(machine.spawned).toEqual([]);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
  });

  test("leaves it alone on a build agent, when turned off, and for a shell it has none for", async () => {
    expect(await installedGlobally({ CI: "true" }).machine().setUpMissing()).toEqual(Result.succeed(MissingCompletion.OnBuildAgent()));
    const off = installedGlobally();
    mkdirSync(join(off.home, ".jive", "completions"), { recursive: true });
    writeFileSync(join(off.home, ".jive", "completions", "jive.off"), "");
    expect(await off.machine().setUpMissing()).toEqual(Result.succeed(MissingCompletion.TurnedOff()));
    expect(await installedGlobally({ SHELL: "/usr/bin/nu" }).machine().setUpMissing())
      .toEqual(Result.succeed(MissingCompletion.NoSupportedShell({ reason: "Tab completion supports bash, zsh, fish and PowerShell; SHELL is /usr/bin/nu." })));
    expect(existsSync(join(off.home, ".zshrc"))).toBe(false);
  });
});
