import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withStartupBlock, withoutStartupBlock } from "./scripts";

/**
 * Each shell's real completion, end to end: `--setup-completion` writes the files into a temporary home, the
 * shell loads them the way a new shell would, and pressing Tab is simulated by calling what the shell itself
 * would call. The CLI on the other end is `fixture-cli.ts`, run as a separate process by its name on PATH.
 *
 * A shell that is not installed is skipped, by name, so the run says which shells it covered.
 */

const FIXTURE = join(import.meta.dir, "fixture-cli.ts");
const which = (shell: string) => Bun.which(shell);

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "shell-completion-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "fixturecli"), `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`);
  chmodSync(join(root, "bin", "fixturecli"), 0o755);
});

/** A home of its own per shell, so one shell's startup files never feed another's. */
async function setUpFor(shell: string): Promise<Record<string, string>> {
  const home = join(root, shell);
  mkdirSync(home, { recursive: true });
  const env = { PATH: `${join(root, "bin")}:${process.env["PATH"] ?? ""}`, HOME: home, ZDOTDIR: home, XDG_CONFIG_HOME: join(home, ".config"), SHELL: `/bin/${shell}` };
  const setUp = Bun.spawn(["fixturecli", "--setup-completion"], { env, stdout: "pipe", stderr: "pipe" });
  expect(await setUp.exited).toBe(0);
  return env;
}

async function shellOutput(argv: ReadonlyArray<string>, environment: Record<string, string>): Promise<Array<string>> {
  const proc = Bun.spawn([...argv], { env: environment, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${stderr}`);
  return stdout.split("\n").filter((line) => line !== "");
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
});

describe.skipIf(which("zsh") === null)("zsh", () => {
  /** Loads .zshrc, replaces `_describe` with one that prints what it was given, and runs the function. */
  const tab = (environment: Record<string, string>, words: ReadonlyArray<string>) => shellOutput([
    "zsh", "-f", "-c",
    `source "$ZDOTDIR/.zshrc"; _describe() { print -rl -- "\${(@P)2}" }
     words=(${["fixturecli", ...words].map((w) => `'${w}'`).join(" ")}); CURRENT=${words.length + 1}
     _fixturecli_complete`,
  ], environment);

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
