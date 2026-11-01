import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStartupBlock, withoutStartupBlock } from "./scripts";

/**
 * Each shell's real completion, end to end: `--setup-completion` writes the startup line into a temporary home,
 * the shell runs it the way a new shell would (so it calls `fixturecli --completion <shell>` and evaluates what
 * that prints), and pressing Tab is simulated by calling what the shell itself would call. The CLI on the other
 * end is `fixture-cli.ts`, run as a separate process by its name on PATH.
 *
 * A shell that is not installed is skipped, by name, so the run says which shells it covered.
 */

// Each Tab starts a shell that starts the fixture through bun, more than once; a cold runner takes seconds.
setDefaultTimeout(30_000);

const FIXTURE = join(import.meta.dir, "fixture-cli.ts");
const which = (shell: string) => Bun.which(shell);

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "shell-completion-"));
  for (const dir of [join(root, "bin"), join(root, "project", "node_modules", ".bin")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "fixturecli"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
    chmodSync(join(dir, "fixturecli"), 0o755);
  }
});

/** A home of its own per test, so one shell's startup files never feed another's. */
function homeFor(name: string, shell: string, binDir = join(root, "bin")): Record<string, string> {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  return { PATH: `${binDir}:${process.env["PATH"] ?? ""}`, HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config"), SHELL: shell };
}

async function fixture(args: ReadonlyArray<string>, env: Record<string, string>) {
  const proc = Bun.spawn(["fixturecli", ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode, stdout, stderr };
}

async function setUpFor(shell: string): Promise<Record<string, string>> {
  const env = homeFor(shell, `/bin/${shell}`);
  expect((await fixture(["--setup-completion"], env)).exitCode).toBe(0);
  return env;
}

async function shellOutput(argv: ReadonlyArray<string>, environment: Record<string, string>): Promise<Array<string>> {
  const proc = Bun.spawn([...argv], { env: environment, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr}`);
  return stdout.split(/\r?\n/).filter((line) => line !== "");
}

describe.skipIf(which("bash") === null)("bash", () => {
  /** Sets COMP_WORDS/COMP_CWORD as bash does on Tab, runs the completion function, prints COMPREPLY. */
  const tab = (environment: Record<string, string>, words: ReadonlyArray<string>) => shellOutput([
    "bash", "--norc", "--noprofile", "-c",
    `for f in "$HOME/.bash_profile" "$HOME/.bashrc"; do [ -f "$f" ] && . "$f"; done
     COMP_WORDS=(${["fixturecli", ...words].map((w) => `'${w}'`).join(" ")}); COMP_CWORD=${words.length}
     _fixturecli_complete; printf '%s\\n' "\${COMPREPLY[@]}"`,
  ], environment);

  test("offers subcommands, listed choices and a flag's listed values", async () => {
    const environment = await setUpFor("bash");
    expect(await tab(environment, [""])).toEqual(["load", "provision"]);
    expect(await tab(environment, ["load", "j"])).toEqual(["jive-sh"]);
    expect(await tab(environment, ["load", "jive-sh", "--branch", ""])).toEqual(["jive-sh-main", "jive-sh-next"]);
    expect(await tab(environment, ["load", "jive-sh", "--"])).toEqual(["--shallow", "--branch", "--help"]);
  });

  test("the startup line does nothing, silently, once the command is uninstalled", async () => {
    const environment = { ...(await setUpFor("bash")), PATH: "/usr/bin:/bin" };
    expect(await shellOutput(["bash", "--norc", "--noprofile", "-c", `for f in "$HOME/.bash_profile" "$HOME/.bashrc"; do [ -f "$f" ] && . "$f"; done; echo started`], environment))
      .toEqual(["started"]);
  });
});

describe.skipIf(which("zsh") === null)("zsh", () => {
  /** Loads .zshrc, replaces `_describe` with one that prints what it was given, and runs the function. */
  const tab = (environment: Record<string, string>, words: ReadonlyArray<string>) => shellOutput([
    "zsh", "-f", "-c",
    `source "$ZDOTDIR/.zshrc"; _describe() { print -rl -- "\${(@P)2}" }
     words=(${["fixturecli", ...words].map((w) => `'${w}'`).join(" ")}); CURRENT=${words.length + 1}
     _fixturecli_complete`,
  ], environment);

  /**
   * What an interactive zsh has registered for the command at its first prompt, after every startup file: a
   * `compinit` resets every `compdef` made before it, which is how a block above a .zshrc's `compinit` used to lose
   * its registration.
   */
  const registeredAtPrompt = async (name: string, compinitBefore: boolean, compinitAfter: boolean) => {
    const environment = homeFor(name, "/bin/zsh");
    const compinit = `autoload -Uz compinit && compinit -C -d "$ZDOTDIR/.zcompdump"\n`;
    writeFileSync(join(environment["HOME"]!, ".zshrc"), compinitBefore ? compinit : "");
    expect((await fixture(["--setup-completion"], environment)).exitCode).toBe(0);
    if (compinitAfter) writeFileSync(join(environment["HOME"]!, ".zshrc"), readFileSync(join(environment["HOME"]!, ".zshrc"), "utf-8") + compinit);
    const proc = Bun.spawn(["zsh", "-i"], { env: environment, stdin: new Blob(['print -r -- "registered:${_comps[fixturecli]}"; exit\n']), stdout: "pipe", stderr: "ignore" });
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return stdout.trim().split("\n").find((line) => line.startsWith("registered:"));
  };

  test("stays registered when the .zshrc runs compinit after the block", async () => {
    expect(await registeredAtPrompt("zsh-compinit-after", false, true)).toBe("registered:_fixturecli_complete");
  });

  test("is registered when compinit runs before the block, and when nothing runs compinit", async () => {
    expect(await registeredAtPrompt("zsh-compinit-before", true, false)).toBe("registered:_fixturecli_complete");
    expect(await registeredAtPrompt("zsh-no-compinit", false, false)).toBe("registered:_fixturecli_complete");
  });

  test("offers values with descriptions as _describe takes them", async () => {
    const environment = await setUpFor("zsh");
    expect(await tab(environment, [""])).toEqual(["load:Clone a repo", "provision"]);
    expect(await tab(environment, ["load", ""])).toEqual(["chaine-dance", "jive-sh"]);
    expect(await tab(environment, ["load", "jive-sh", "--b"])).toEqual(["--branch"]);
  });
});

describe.skipIf(which("fish") === null)("fish", () => {
  /** fish's own `complete -C` completes a command line without a terminal. */
  const tab = (environment: Record<string, string>, line: string) =>
    shellOutput(["fish", "--no-config", "-c", `source "$XDG_CONFIG_HOME/fish/completions/fixturecli.fish"; complete -C '${line}'`], environment);

  test("offers values with descriptions", async () => {
    const environment = await setUpFor("fish");
    expect(await tab(environment, "fixturecli ")).toEqual(["load\tClone a repo", "provision"]);
    expect(await tab(environment, "fixturecli load jive-sh --branch j")).toEqual(["jive-sh-main", "jive-sh-next"]);
  });
});

describe.skipIf(which("pwsh") === null)("PowerShell", () => {
  /** Loads the profile pwsh reports, then asks PowerShell's own TabExpansion2 to complete the line. */
  const tab = (environment: Record<string, string>, line: string) => shellOutput([
    "pwsh", "-NoProfile", "-NonInteractive", "-Command",
    `. $PROFILE.CurrentUserAllHosts; (TabExpansion2 -inputScript '${line}' -cursorColumn ${line.length}).CompletionMatches | ForEach-Object { "$($_.CompletionText)\`t$($_.ToolTip)" }`,
  ], environment);

  test("offers values with descriptions, including after a space", async () => {
    const environment = await setUpFor("pwsh");
    expect(await tab(environment, "fixturecli ")).toEqual(["load\tClone a repo", "provision\tprovision"]);
    expect(await tab(environment, "fixturecli lo")).toEqual(["load\tClone a repo"]);
    expect(await tab(environment, "fixturecli load ")).toEqual(["chaine-dance\tchaine-dance", "jive-sh\tjive-sh"]);
    expect(await tab(environment, "fixturecli load jive-sh --branch j")).toEqual(["jive-sh-main\tjive-sh-main", "jive-sh-next\tjive-sh-next"]);
  });
});

describe("setting up missing completion from a real command", () => {
  test("sets it up once when the command on PATH speaks the protocol, saying so on stderr only", async () => {
    const env = homeFor("missing-global", "/bin/zsh");
    const first = await fixture(["--setup-completion-if-missing"], env);
    expect(first).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: `Set up Tab completion for fixturecli in ${join(env["HOME"]!, ".zshrc")}; it starts in new shells (turn it off with: fixturecli --remove-completion).\n`,
    });
    expect(await fixture(["--setup-completion-if-missing"], env)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  });

  test("a copy found only in a project's node_modules/.bin sets nothing up", async () => {
    const env = homeFor("missing-project", "/bin/zsh", join(root, "project", "node_modules", ".bin"));
    expect(await fixture(["--setup-completion-if-missing"], env)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(existsSync(join(env["HOME"]!, ".zshrc"))).toBe(false);
  });

  test("--remove-completion keeps it off", async () => {
    const env = homeFor("missing-off", "/bin/zsh");
    expect((await fixture(["--setup-completion"], env)).exitCode).toBe(0);
    expect((await fixture(["--remove-completion"], env)).exitCode).toBe(0);
    expect(await fixture(["--setup-completion-if-missing"], env)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(join(env["HOME"]!, ".zshrc"), "utf-8")).toBe("");
  });

  /**
   * The command itself, compiled as an installed command is, with no install script ever run (as when Bun skips it):
   * its first run sets completion up, and later runs of the same version only read the version it recorded.
   */
  test("the first run of an installed command sets completion up, with no install script", async () => {
    const compiledBin = join(root, "compiled-bin");
    mkdirSync(compiledBin, { recursive: true });
    const built = Bun.spawnSync([process.execPath, "build", "--compile", FIXTURE, "--outfile", join(compiledBin, "fixturecli")], { stdout: "pipe", stderr: "pipe" });
    expect(built.exitCode).toBe(0);
    const env = homeFor("first-run", "/bin/zsh", compiledBin);
    const run = async () => {
      const proc = Bun.spawn([join(compiledBin, "fixturecli"), "provision", "package"], { env, stdout: "pipe", stderr: "pipe" });
      const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { exitCode, stdout, stderr };
    };
    expect(await run()).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: `Set up Tab completion for fixturecli in ${join(env["HOME"]!, ".zshrc")}; it starts in new shells (turn it off with: fixturecli --remove-completion).\n`,
    });
    expect(readFileSync(join(env["HOME"]!, ".zshrc"), "utf-8")).toContain("# begin fixturecli completion");
    expect(readFileSync(join(env["HOME"]!, ".jive", "completions", "fixturecli.checked"), "utf-8")).toBe("0.0.0\n");
    expect(await run()).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  }, 120_000);
});

describe("startup file editing", () => {
  const block = "# begin x completion\nline\n# end x completion\n";

  test("appends after a blank line, and removing restores the file exactly", () => {
    for (const original of ["", "a\n", "a"]) {
      const added = withStartupBlock(original, "x", block);
      expect(added.endsWith(block)).toBe(true);
      expect(withoutStartupBlock(added, "x")).toBe(original === "a" ? "a\n" : original);
    }
  });

  test("replaces an existing block in place and leaves another command's alone", () => {
    const other = "# begin y completion\ny\n# end y completion\n";
    const content = `top\n\n# begin x completion\nold\n# end x completion\n\n${other}`;
    expect(withStartupBlock(content, "x", block)).toBe(`top\n\n${block}\n${other}`);
    expect(withoutStartupBlock(content, "x")).toBe(`top\n\n${other}`);
  });
});
