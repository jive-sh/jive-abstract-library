import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PLATFORMS } from "../modules/builder/interface";

const PKG = "@test/demo";
const platform = PLATFORMS.find((p) => p.os === process.platform && p.cpu === process.arch)!.id;

/**
 * A bun global install of `PKG` 1.0.0 in a throwaway directory, and a fake `bun` that answers `info` with
 * the given dist-tags, records `add`, and records running the install script.
 */
function fakeInstall(tags: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "auto-upgrade-test-")));
  const global = join(root, ".bun/install/global");
  const packageDir = join(global, "node_modules", PKG);
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(global, "package.json"), "{}");
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PKG, version: "1.0.0" }));
  writeFileSync(join(packageDir, "bin", "demo"), "");
  writeFileSync(join(packageDir, "install.cjs"), "");
  mkdirSync(join(global, "node_modules", `${PKG}-${platform}`), { recursive: true });
  writeFileSync(join(global, "node_modules", `${PKG}-${platform}`, "package.json"), JSON.stringify({ name: PKG }));

  const bin = join(root, "fake-bin");
  mkdirSync(bin);
  writeFileSync(join(root, "tags.json"), JSON.stringify(tags));
  writeFileSync(join(bin, "bun"), [
    "#!/bin/sh",
    `if [ "$1" = info ]; then echo "$PWD" > "${root}/info-cwd"; cat "${root}/tags.json"; exit 0; fi`,
    `if [ "$1" = add ]; then echo "$@ BUN_INSTALL=$BUN_INSTALL" > "${root}/added"; exit 0; fi`,
    `echo "$@" > "${root}/install-script-ran"`,
  ].join("\n"));
  chmodSync(join(bin, "bun"), 0o755);
  return { root, commandPath: join(packageDir, "bin", "demo"), searchPath: `${bin}:/bin:/usr/bin` };
}

/** Runs autoUpgrade in its own process, as a daemon would, until `done` holds or 20 seconds pass. */
async function runAutoUpgrade(install: ReturnType<typeof fakeInstall>, done: () => boolean): Promise<string> {
  const library = resolve(import.meta.dir, "auto-upgrade.ts");
  const child = spawn(process.execPath, ["-e", `import { autoUpgrade } from ${JSON.stringify(library)};
    autoUpgrade({ packageName: ${JSON.stringify(PKG)}, commandPath: ${JSON.stringify(install.commandPath)} });`], {
    cwd: install.root, env: { ...process.env, PATH: install.searchPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  for (let waited = 0; waited < 20_000 && !done(); waited += 100) await Bun.sleep(100);
  await Bun.sleep(300);
  child.kill();
  return output;
}

describe.skipIf(process.platform === "win32")("autoUpgrade", () => {
  test("installs a newer version once this platform's build is out, with the manager that installed it", async () => {
    const install = fakeInstall({ latest: "1.0.1", [`latest-${platform}`]: `1.0.1-latest-${platform}` });
    const output = await runAutoUpgrade(install, () => existsSync(join(install.root, "install-script-ran")));
    expect(readFileSync(join(install.root, "info-cwd"), "utf8").trim()).toBe(join(install.root, ".bun/install/global"));
    expect(readFileSync(join(install.root, "added"), "utf8").trim())
      .toBe(`add --no-cache -g ${PKG}@1.0.1 BUN_INSTALL=${join(install.root, ".bun")}`);
    expect(readFileSync(join(install.root, "install-script-ran"), "utf8").trim())
      .toBe(join(install.root, ".bun/install/global/node_modules", PKG, "install.cjs"));
    expect(output).toContain(`Upgrading ${PKG} from 1.0.0 to 1.0.1 with bun`);
    expect(output).toContain("this process was not restarted");
  }, 30_000);

  test("waits while this platform's build of the new version is not published", async () => {
    const install = fakeInstall({ latest: "1.0.1", [`latest-${platform}`]: `1.0.0-latest-${platform}` });
    const output = await runAutoUpgrade(install, () => existsSync(join(install.root, "info-cwd")));
    expect(existsSync(join(install.root, "added"))).toBe(false);
    expect(output).toContain(`${PKG} 1.0.1 is published but its ${platform} build is not yet`);
  }, 30_000);

  test("does nothing when the installed version is the latest", async () => {
    const install = fakeInstall({ latest: "1.0.0", [`latest-${platform}`]: `1.0.0-latest-${platform}` });
    const output = await runAutoUpgrade(install, () => existsSync(join(install.root, "info-cwd")));
    expect(existsSync(join(install.root, "added"))).toBe(false);
    expect(output).toContain(`Keeping ${PKG} 1.0.0 up to date`);
    expect(output).not.toContain(`Upgrading ${PKG} from`);
  }, 30_000);

  test("says once that it will not upgrade a command outside an install", async () => {
    const install = fakeInstall({});
    const commandPath = join(install.root, "checkout/dist/base/bin/demo");
    mkdirSync(join(commandPath, ".."), { recursive: true });
    writeFileSync(commandPath, "");
    const output = await runAutoUpgrade({ ...install, commandPath }, () => false);
    expect(output.match(/Not upgrading/g)).toEqual(["Not upgrading"]);
  }, 30_000);
});
