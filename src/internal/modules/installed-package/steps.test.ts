import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";
import type { Install } from "./interface";
import { installSteps, shellScript } from "./steps";

const PKG = "@jive-sh/skill-sync";
const install = (overrides: Partial<Install>): Install => ({
  packageManager: "bun", scope: "global", cwd: "/home/me/.bun/install/global",
  packageDir: `/home/me/.bun/install/global/node_modules/${PKG}`, env: {}, ...overrides,
});

describe("installSteps", () => {
  test("bun installs the exact version, then runs the install script through the install's node_modules", () => {
    expect(installSteps({ packageName: PKG, install: install({}), version: "0.4.5" })).toEqual([
      { argv: ["bun", "add", "--no-cache", "-g", `${PKG}@0.4.5`], onlyIfExists: Option.none() },
      {
        argv: ["bun", `/home/me/.bun/install/global/node_modules/${PKG}/install.cjs`],
        onlyIfExists: Option.some(`/home/me/.bun/install/global/node_modules/${PKG}/install.cjs`),
      },
    ]);
  });

  test("pnpm's install script is found through the link, not the old version's store directory", () => {
    const steps = installSteps({
      packageName: PKG,
      install: install({ packageManager: "pnpm", cwd: "/p/global/5", packageDir: `/p/global/5/node_modules/.pnpm/x@0.4.4/node_modules/${PKG}` }),
      version: "latest",
    });
    expect(steps.map((step) => step.argv)).toEqual([
      ["pnpm", "add", "-g", `${PKG}@latest`],
      ["node", `/p/global/5/node_modules/${PKG}/install.cjs`],
    ]);
  });

  test("npm runs install scripts itself, so it is one step", () => {
    expect(installSteps({ packageName: PKG, install: install({ packageManager: "npm", scope: "local" }), version: "1.0.0" })
      .map((step) => step.argv)).toEqual([["npm", "install", `${PKG}@1.0.0`]]);
  });
});

describe.skipIf(process.platform === "win32")("shellScript", () => {
  const run = (script: string) => spawnSync("/bin/sh", ["-c", script], { encoding: "utf8" });

  test("runs every step in order in the directory, quoting arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "steps-test-"));
    const result = run(shellScript([
      { argv: ["sh", "-c", "echo \"it's $1\" > out", "-", "one two"], onlyIfExists: Option.none() },
      { argv: ["sh", "-c", "echo second >> out"], onlyIfExists: Option.none() },
    ], dir));
    expect(result.status).toBe(0);
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("it's one two\nsecond\n");
  });

  test("a step whose file is missing is skipped, and one whose file an earlier step created runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "steps-test-"));
    const result = run(shellScript([
      { argv: ["touch", "made"], onlyIfExists: Option.none() },
      { argv: ["touch", "ran-made"], onlyIfExists: Option.some(join(dir, "made")) },
      { argv: ["touch", "ran-missing"], onlyIfExists: Option.some(join(dir, "missing")) },
    ], dir));
    expect(result.status).toBe(0);
    expect([existsSync(join(dir, "ran-made")), existsSync(join(dir, "ran-missing"))]).toEqual([true, false]);
  });

  test("stops at the first failure with its exit code", () => {
    const dir = mkdtempSync(join(tmpdir(), "steps-test-"));
    writeFileSync(join(dir, "marker"), "");
    const result = run(shellScript([
      { argv: ["sh", "-c", "exit 7"], onlyIfExists: Option.none() },
      { argv: ["rm", "marker"], onlyIfExists: Option.none() },
    ], dir));
    expect(result.status).toBe(7);
    expect(existsSync(join(dir, "marker"))).toBe(true);
  });
});
