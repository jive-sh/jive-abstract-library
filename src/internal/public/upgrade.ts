import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { Effect, Option, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { INSTALL_SCRIPT } from "../common/constants";
import { libraryModules, type LibraryModules } from "../modules";
import { OSPlatformImpl } from "../modules/os-platform/impl";

/**
 * Upgrades an installed package to its latest version with the package manager that installed it.
 *
 * Every package built from this library can offer an `upgrade` command that is one call to this. Where
 * the running command lives says how it was installed — globally or into a project, by bun, pnpm, yarn
 * or npm — and the same manager then installs `<package>@latest` the same way.
 *
 * After installing, the new version's `install.js` is run whenever the manager skips install scripts
 * (bun and pnpm do, for packages not on their allowlist). Skipped, the package's commands stay JS
 * launchers until first run, and a registered daemon — which a service manager starts without `node` on
 * its PATH — fails at its next start and is never re-registered for the new version.
 */

export interface UpgradeOptions {
  /** The package to upgrade, e.g. `@jive-sh/skill-sync`. */
  readonly packageName: string;
  /** The running command. Defaults to this process's executable, which is right for a compiled command. */
  readonly commandPath?: string;
}

type PackageManager = "bun" | "pnpm" | "npm" | "yarn";

interface Install {
  readonly pm: PackageManager;
  readonly scope: "global" | "local";
  /** The project, for a local install: the package manager runs there. */
  readonly cwd?: string;
  /** The installed package's directory, where the new version's `install.js` will be. */
  readonly packageDir?: string;
}

export const upgrade = (options: UpgradeOptions): Effect.Effect<void, string> => pipe(
  effunct(upgradeAction)(options),
  Effect.provide(OSPlatformImpl.Layer),
);

function* upgradeAction(options: UpgradeOptions): EffectGen<void, string, LibraryModules.OSPlatform> {
  const osPlatform = yield* libraryModules.OSPlatform;
  const commandPath = options.commandPath ?? (yield* osPlatform.getExecutablePath());
  const install = detectInstall(options.packageName, commandPath);
  if (Option.isNone(install)) {
    return yield* Effect.fail(
      `could not tell how ${options.packageName} was installed from ${commandPath}; upgrade it with your package manager`,
    );
  }
  const { pm, scope, cwd, packageDir } = install.value;
  const cwdOrHere = cwd ?? (yield* osPlatform.getCurrentDirectory());

  const commands = [installCommand(options.packageName, install.value)];
  if (pm === "bun" || pm === "pnpm") {
    // Run with the manager's own runtime: a bun-only machine may have no `node`.
    if (packageDir !== undefined) commands.push([pm === "bun" ? "bun" : "node", path.join(packageDir, INSTALL_SCRIPT)]);
  }
  console.log(`${options.packageName} was installed ${scope === "global" ? "globally" : "in this project"} with ${pm}.`);

  // Windows locks a running executable, so replacing the package from inside this process fails with
  // EBUSY. A helper waits for this process to exit and then runs the same commands.
  if (process.platform === "win32") {
    spawnWindowsUpdater(commands, cwdOrHere);
    console.log("The upgrade continues in a separate window once this command exits.");
    return;
  }

  for (const command of commands) {
    // The new version's install script exists only once the install has run, so it is checked here.
    if (command[1]?.endsWith(INSTALL_SCRIPT) && !existsSync(command[1])) continue;
    console.log(`Running: ${command.join(" ")}`);
    const result = yield* osPlatform.spawnProcess({
      command: command[0]!, args: command.slice(1), cwd: cwdOrHere, stdout: "inherit", stderr: "inherit",
    });
    if (result.exitCode !== 0) return yield* Effect.fail(`${command.join(" ")} exited with code ${result.exitCode}`);
  }
}

/*
 * Install layouts this recognises, shown for a package `pkg` with command `cmd`:
 *
 *   project/node_modules/.bin/cmd -> ../pkg/bin/cmd             local, any manager
 *   ~/.bun/install/global/node_modules/pkg/bin/cmd              bun global (~/.bun/bin/cmd links here)
 *   ~/Library/pnpm/…, ~/.local/share/pnpm/global/…, ~/.pnpm-global/…   pnpm global
 *   ~/.config/yarn/global/node_modules/pkg/…, ~/.yarn/bin/cmd   yarn classic global
 *   ~/.nvm/versions/node/vX/lib/node_modules/pkg/…, /usr/local/lib/node_modules/pkg/…,
 *   /opt/homebrew/lib/node_modules/pkg/…, %APPDATA%/npm/node_modules/pkg/…        npm global
 *
 * The command's real path is used, so a link in a bin directory resolves to the package it belongs to.
 */
export function detectInstall(packageName: string, commandPath: string): Option.Option<Install> {
  const real = normalize(resolveLinks(commandPath));
  const packageSegment = `/node_modules/${packageName}/`;
  const at = real.toLowerCase().indexOf(packageSegment.toLowerCase());
  const packageDir = at >= 0 ? real.slice(0, at + packageSegment.length - 1) : undefined;

  const global = globalManager(real);
  if (Option.isSome(global)) return Option.some({ pm: global.value, scope: "global", packageDir });

  const binAt = real.toLowerCase().indexOf("/node_modules/.bin/");
  const root = binAt >= 0 ? real.slice(0, binAt) : at >= 0 ? real.slice(0, at) : undefined;
  if (root === undefined || !hasProjectMarkers(root)) return Option.none();
  const pm = Option.getOrElse(projectManager(root), () => "npm" as PackageManager);
  return Option.some({ pm, scope: "local", cwd: root, packageDir });
}

function globalManager(real: string): Option.Option<PackageManager> {
  const p = real.toLowerCase();
  if (p.includes("/.bun/bin/") || p.includes("/.bun/install/global/node_modules/")) return Option.some("bun");
  if (p.includes("/.pnpm-global/") || p.includes("/pnpm/global/") || p.includes("/library/pnpm/")
    || p.includes("/appdata/local/pnpm/")) return Option.some("pnpm");
  if (p.includes("/.yarn/bin/") || p.includes("/appdata/local/yarn/bin/") || p.includes("/.config/yarn/global/node_modules/")
    || (p.includes("/appdata/local/yarn/") && p.includes("/global/node_modules/"))) return Option.some("yarn");
  if (p.includes("/.nvm/versions/node/") || p.includes("/.nodenv/versions/") || p.includes("/.asdf/installs/nodejs/")
    || p.includes("/appdata/roaming/npm/") || p.includes("/program files/nodejs/node_modules/")
    || p.startsWith("/usr/local/bin/") || p.startsWith("/opt/homebrew/bin/") || p.startsWith("/usr/local/lib/node_modules/")
    || p.startsWith("/opt/homebrew/lib/node_modules/") || p.startsWith("/usr/lib/node_modules/")) return Option.some("npm");
  return Option.none();
}

function installCommand(packageName: string, install: Install): string[] {
  const spec = `${packageName}@latest`;
  if (install.scope === "global") {
    if (install.pm === "bun") return ["bun", "add", "--no-cache", "-g", spec];
    if (install.pm === "pnpm") return ["pnpm", "add", "-g", spec];
    if (install.pm === "yarn") return ["yarn", "global", "add", spec];
    return ["npm", "install", "-g", spec];
  }
  if (install.pm === "bun") return ["bun", "add", "--no-cache", spec];
  if (install.pm === "pnpm") return ["pnpm", "add", spec];
  if (install.pm === "yarn") return ["yarn", "add", spec];
  return ["npm", "install", spec];
}

function hasProjectMarkers(dir: string): boolean {
  return ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]
    .some((file) => existsSync(path.join(dir, file)));
}

/** The project's declared manager (`packageManager`, `devEngines`), else its lockfile, searching upwards. */
function projectManager(dir: string): Option.Option<PackageManager> {
  for (let current = dir; ; current = normalize(path.dirname(current))) {
    const declared = declaredManager(current);
    if (Option.isSome(declared)) return declared;
    if (existsSync(path.join(current, "bun.lock")) || existsSync(path.join(current, "bun.lockb"))) return Option.some("bun");
    if (existsSync(path.join(current, "pnpm-lock.yaml"))) return Option.some("pnpm");
    if (existsSync(path.join(current, "yarn.lock"))) return Option.some("yarn");
    if (existsSync(path.join(current, "package-lock.json"))) return Option.some("npm");
    if (normalize(path.dirname(current)) === current) return Option.none();
  }
}

function declaredManager(dir: string): Option.Option<PackageManager> {
  const manifest = path.join(dir, "package.json");
  if (!existsSync(manifest)) return Option.none();
  try {
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      packageManager?: unknown;
      devEngines?: { packageManager?: { name?: unknown } | { name?: unknown }[] };
    };
    const engines = json.devEngines?.packageManager;
    const candidates = [json.packageManager, ...(Array.isArray(engines) ? engines : [engines]).map((entry) => entry?.name)];
    for (const candidate of candidates) {
      const name = typeof candidate === "string" ? candidate.split("@")[0] : undefined;
      if (name === "bun" || name === "pnpm" || name === "yarn" || name === "npm") return Option.some(name);
    }
  } catch {
    // An unreadable manifest says nothing about the manager; the lockfiles may.
  }
  return Option.none();
}

function resolveLinks(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

const normalize = (file: string): string => file.replace(/\\/g, "/");

const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** A detached PowerShell that waits for this process to exit, then runs each command in turn. */
function spawnWindowsUpdater(commands: string[][], cwd: string): void {
  const steps = commands.flatMap((command) => {
    const run = `& ${command.map(quotePowerShell).join(" ")}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    const script = command[1]?.endsWith(INSTALL_SCRIPT) ? `if (Test-Path -LiteralPath ${quotePowerShell(command[1])}) { ${run} }` : run;
    return [`Write-Host ${quotePowerShell(`Running: ${command.join(" ")}`)}`, script];
  });
  const program = [
    "$ErrorActionPreference = 'Stop'",
    "Write-Host 'Waiting for the current process to exit before upgrading...'",
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }`,
    `Set-Location -LiteralPath ${quotePowerShell(cwd)}`,
    ...steps,
  ].join("; ");
  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", program], {
    cwd, detached: true, stdio: "inherit",
  }).unref();
}
