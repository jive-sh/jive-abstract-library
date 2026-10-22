import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";
import { detectInstall } from "./upgrade";

const PKG = "@jive-sh/skill-sync";

/** A real directory tree, so detection sees the same realpaths and lockfiles it would on a machine. */
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "upgrade-test-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

describe("detectInstall", () => {
  test("bun global, through the ~/.bun/bin link, finds the package directory", () => {
    const root = tree({ [`.bun/install/global/node_modules/${PKG}/bin/skill-sync`]: "" });
    mkdirSync(join(root, ".bun/bin"), { recursive: true });
    symlinkSync(join(root, `.bun/install/global/node_modules/${PKG}/bin/skill-sync`), join(root, ".bun/bin/skill-sync"));
    const install = Option.getOrThrow(detectInstall(PKG, join(root, ".bun/bin/skill-sync")));
    expect(install.pm).toBe("bun");
    expect(install.scope).toBe("global");
    expect(install.packageDir?.endsWith(`/.bun/install/global/node_modules/${PKG}`)).toBe(true);
  });

  test("npm global under nvm", () => {
    const root = tree({ [`.nvm/versions/node/v24.0.0/lib/node_modules/${PKG}/bin/skill-sync`]: "" });
    const install = Option.getOrThrow(detectInstall(PKG, join(root, `.nvm/versions/node/v24.0.0/lib/node_modules/${PKG}/bin/skill-sync`)));
    expect(install).toMatchObject({ pm: "npm", scope: "global" });
  });

  test("local install takes the project's declared package manager over its lockfile", () => {
    const root = tree({
      "project/package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      "project/package-lock.json": "{}",
      [`project/node_modules/${PKG}/bin/skill-sync`]: "",
    });
    const install = Option.getOrThrow(detectInstall(PKG, join(root, `project/node_modules/${PKG}/bin/skill-sync`)));
    expect(install).toMatchObject({ pm: "pnpm", scope: "local" });
    expect(install.cwd?.endsWith("/project")).toBe(true);
  });

  test("local install falls back to the lockfile", () => {
    const root = tree({ "project/package.json": "{}", "project/bun.lock": "", [`project/node_modules/${PKG}/bin/x`]: "" });
    expect(Option.getOrThrow(detectInstall(PKG, join(root, `project/node_modules/${PKG}/bin/x`))).pm).toBe("bun");
  });

  test("a command outside any install is not guessed at", () => {
    const root = tree({ "checkout/dist/base/bin/skill-sync": "" });
    expect(Option.isNone(detectInstall(PKG, join(root, "checkout/dist/base/bin/skill-sync")))).toBe(true);
  });
});
