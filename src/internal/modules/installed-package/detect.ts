import { existsSync, readFileSync, realpathSync } from "node:fs";
import * as path from "node:path";
import { Option } from "effect";
import type { Install, PackageManagerName } from "./interface";

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
 * The first `node_modules` in it is the install's: pnpm nests the package in a second one inside `.pnpm`.
 */
export function detectInstall(input: {
  readonly packageName: string;
  readonly commandPath: string;
  readonly searchPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Option.Option<Install> {
  const real = normalize(resolveLinks(input.commandPath));
  const packageSegment = `/node_modules/${input.packageName}/`;
  const at = real.toLowerCase().indexOf(packageSegment.toLowerCase());
  if (at < 0) return Option.none();
  const packageDir = real.slice(0, at + packageSegment.length - 1);
  const root = real.slice(0, real.toLowerCase().indexOf("/node_modules/"));

  const global = globalManager(real);
  if (Option.isSome(global)) {
    return Option.some({
      packageManager: global.value,
      scope: "global",
      cwd: root,
      packageDir,
      env: managerEnvironment({ ...input, packageManager: global.value, root }),
    });
  }

  if (!hasProjectMarkers(root)) return Option.none();
  const packageManager = Option.getOrElse(projectManager(root), () => "npm" as PackageManagerName);
  return Option.some({ packageManager, scope: "local", cwd: root, packageDir, env: withPath(input.environment, input.searchPath) });
}

function globalManager(real: string): Option.Option<PackageManagerName> {
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

/**
 * Bun keeps global packages in `$BUN_INSTALL/install/global`, and pnpm in `$PNPM_HOME/global/<n>`; each
 * reads that variable to find the directory again. A shell sets them, a service manager does not.
 */
function managerEnvironment(input: {
  readonly packageManager: PackageManagerName;
  readonly root: string;
  readonly searchPath: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}): Record<string, string | undefined> {
  const env = withPath(input.environment, input.searchPath);
  const bunHome = /^(.*)\/install\/global$/.exec(input.root)?.[1];
  if (input.packageManager === "bun" && bunHome !== undefined) env["BUN_INSTALL"] = bunHome;
  const pnpmHome = /^(.*)\/global\/\d+$/.exec(input.root)?.[1];
  if (input.packageManager === "pnpm" && pnpmHome !== undefined) env["PNPM_HOME"] = pnpmHome;
  return env;
}

/** Windows spells it `Path` and treats the name case-insensitively, so every spelling is replaced. */
function withPath(environment: Readonly<Record<string, string | undefined>>, searchPath: string): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => key.toUpperCase() !== "PATH"));
  env["PATH"] = searchPath;
  return env;
}

function hasProjectMarkers(dir: string): boolean {
  return ["package.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"]
    .some((file) => existsSync(path.join(dir, file)));
}

/** The project's declared manager (`packageManager`, `devEngines`), else its lockfile, searching upwards. */
function projectManager(dir: string): Option.Option<PackageManagerName> {
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

function declaredManager(dir: string): Option.Option<PackageManagerName> {
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
