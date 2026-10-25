import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Option } from "effect";
import { detectInstall } from "./detect";

const PKG = "@jive-sh/skill-sync";
const SEARCH_PATH = "/from/the/registration:/usr/bin";

/** A real directory tree, so detection sees the same realpaths and lockfiles it would on a machine. */
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "upgrade-test-")));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

const detect = (commandPath: string, environment: Record<string, string> = { PATH: "/usr/bin", HOME: "/home/me" }) =>
  detectInstall({ packageName: PKG, commandPath, searchPath: SEARCH_PATH, environment });

describe("detectInstall", () => {
  test("bun global, through the ~/.bun/bin link, runs bun in its global directory with BUN_INSTALL set", () => {
    const root = tree({ [`.bun/install/global/node_modules/${PKG}/bin/skill-sync`]: "", ".bun/install/global/package.json": "{}" });
    mkdirSync(join(root, ".bun/bin"), { recursive: true });
    symlinkSync(join(root, `.bun/install/global/node_modules/${PKG}/bin/skill-sync`), join(root, ".bun/bin/skill-sync"));
    const install = Option.getOrThrow(detect(join(root, ".bun/bin/skill-sync")));
    expect(install).toMatchObject({
      packageManager: "bun",
      scope: "global",
      cwd: join(root, ".bun/install/global"),
      packageDir: join(root, `.bun/install/global/node_modules/${PKG}`),
    });
    expect(install.env).toEqual({ PATH: SEARCH_PATH, HOME: "/home/me", BUN_INSTALL: join(root, ".bun") });
  });

  test("npm global under nvm runs in the prefix's lib directory", () => {
    const root = tree({ [`.nvm/versions/node/v24.0.0/lib/node_modules/${PKG}/bin/skill-sync`]: "" });
    const install = Option.getOrThrow(detect(join(root, `.nvm/versions/node/v24.0.0/lib/node_modules/${PKG}/bin/skill-sync`)));
    expect(install).toMatchObject({ packageManager: "npm", scope: "global", cwd: join(root, ".nvm/versions/node/v24.0.0/lib") });
    expect(install.env["BUN_INSTALL"]).toBeUndefined();
  });

  test("pnpm global finds its global directory past the .pnpm store, and sets PNPM_HOME", () => {
    const real = `Library/pnpm/global/5/node_modules/.pnpm/@jive-sh+skill-sync@0.4.4/node_modules/${PKG}/bin/skill-sync`;
    const root = tree({ [real]: "" });
    const install = Option.getOrThrow(detect(join(root, real)));
    expect(install).toMatchObject({
      packageManager: "pnpm",
      scope: "global",
      cwd: join(root, "Library/pnpm/global/5"),
      packageDir: join(root, `Library/pnpm/global/5/node_modules/.pnpm/@jive-sh+skill-sync@0.4.4/node_modules/${PKG}`),
    });
    expect(install.env["PNPM_HOME"]).toBe(join(root, "Library/pnpm"));
  });

  test("the search path replaces PATH however the environment spells it", () => {
    const root = tree({ [`.bun/install/global/node_modules/${PKG}/bin/skill-sync`]: "" });
    const install = Option.getOrThrow(detect(join(root, `.bun/install/global/node_modules/${PKG}/bin/skill-sync`), { Path: "C:/old" }));
    expect(install.env["Path"]).toBeUndefined();
    expect(install.env["PATH"]).toBe(SEARCH_PATH);
  });

  test("local install takes the project's declared package manager over its lockfile", () => {
    const root = tree({
      "project/package.json": JSON.stringify({ packageManager: "pnpm@10.0.0" }),
      "project/package-lock.json": "{}",
      [`project/node_modules/${PKG}/bin/skill-sync`]: "",
    });
    const install = Option.getOrThrow(detect(join(root, `project/node_modules/${PKG}/bin/skill-sync`)));
    expect(install).toMatchObject({ packageManager: "pnpm", scope: "local", cwd: join(root, "project") });
  });

  test("local install falls back to the lockfile", () => {
    const root = tree({ "project/package.json": "{}", "project/bun.lock": "", [`project/node_modules/${PKG}/bin/x`]: "" });
    expect(Option.getOrThrow(detect(join(root, `project/node_modules/${PKG}/bin/x`))).packageManager).toBe("bun");
  });

  test("a command outside any install is not guessed at", () => {
    const root = tree({ "checkout/dist/base/bin/skill-sync": "" });
    expect(Option.isNone(detect(join(root, "checkout/dist/base/bin/skill-sync")))).toBe(true);
  });
});
