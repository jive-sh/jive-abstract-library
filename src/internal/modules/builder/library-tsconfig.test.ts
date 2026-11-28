import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * This library's published tsconfig.json, as a consumer gets it: the built dist/base (which CI builds before the tests) is
 * packed, unpacked into a consumer's node_modules as an install lays it out, and the consumer's whole tsconfig is
 * `{ "extends": "jive-abstract-library/tsconfig.json" }`. The package's `exports` must list the file for TypeScript to
 * resolve it, and `${configDir}` must point at the consumer, not at node_modules.
 */

const root = join(import.meta.dir, "..", "..", "..", "..");
const base = join(root, "dist", "base");
const built = existsSync(join(base, "tsconfig.json"));
if (!built && process.env["CI"] !== undefined) throw new Error(`${base} has no tsconfig.json: CI runs the build before this test`);

// Under the repo, so the consumer finds @types/bun in this package's node_modules as an installed consumer finds its own.
const consumer = join(root, ".scratch", "consumer-extends-tsconfig");
const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

function run(cmd: ReadonlyArray<string>, cwd: string) {
  const result = Bun.spawnSync({ cmd: [...cmd], cwd });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}

test.skipIf(!built || process.platform === "win32")("a consumer extending jive-abstract-library/tsconfig.json gets every check, scoped to its own src", () => {
  rmSync(consumer, { recursive: true, force: true });
  const installed = join(consumer, "node_modules", "jive-abstract-library");
  mkdirSync(installed, { recursive: true });
  mkdirSync(join(consumer, "src"), { recursive: true });
  try {
    expect(run(["bun", "pm", "pack", "--destination", consumer], base).exitCode).toBe(0);
    const tarball = readdirSync(consumer).find((name) => name.endsWith(".tgz"));
    expect(tarball).toBeDefined();
    expect(run(["tar", "-xzf", join(consumer, tarball ?? ""), "-C", installed, "--strip-components", "1"], consumer).exitCode).toBe(0);

    writeFileSync(join(consumer, "tsconfig.json"), `{ "extends": "jive-abstract-library/tsconfig.json" }\n`);
    writeFileSync(join(consumer, "src", "index.ts"), "const names: Array<string> = [];\nexport const first: string = names[0];\n");
    const unchecked = run([tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], consumer);
    expect(unchecked.exitCode).not.toBe(0);
    expect(unchecked.output).toContain("src/index.ts(2,14): error TS2322");

    writeFileSync(join(consumer, "src", "index.ts"), "const names: Array<string> = [];\nexport const first: string | undefined = names[0];\n");
    expect(run([tsc, "--noEmit", "-p", "tsconfig.json", "--pretty", "false"], consumer)).toEqual({ exitCode: 0, output: "" });

    const shown = JSON.parse(run([tsc, "--showConfig", "-p", "tsconfig.json"], consumer).output);
    expect(shown.include).toEqual([join(consumer, "src", "**", "*.ts")]);
    expect(shown.compilerOptions.exactOptionalPropertyTypes).toBe(true);
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
});
