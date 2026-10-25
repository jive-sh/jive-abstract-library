import * as path from "node:path";
import { Option } from "effect";
import { INSTALL_SCRIPT } from "../../common/constants";
import type { Install } from "./interface";

/**
 * The commands an install is made of, and how each kind of runner writes them down. Kept as data so the
 * attached run, the detached shell and the Windows helper run exactly the same steps.
 */

export interface InstallStep {
  readonly argv: ReadonlyArray<string>;
  /** Run only if this file exists by the time the step is reached; it may be created by an earlier step. */
  readonly onlyIfExists: Option.Option<string>;
}

export function installSteps(input: { readonly packageName: string; readonly install: Install; readonly version: string }): ReadonlyArray<InstallStep> {
  const { packageName, install, version } = input;
  const steps: InstallStep[] = [{ argv: installCommand(install, `${packageName}@${version}`), onlyIfExists: Option.none() }];
  if (install.packageManager === "bun" || install.packageManager === "pnpm") {
    // Through the install's own node_modules rather than packageDir: pnpm puts each version in a directory
    // of its own, so the old one's path does not lead to the new install script.
    const script = path.join(install.cwd, "node_modules", packageName, INSTALL_SCRIPT);
    // With the manager's own runtime: a bun-only machine may have no `node`.
    steps.push({ argv: [install.packageManager === "bun" ? "bun" : "node", script], onlyIfExists: Option.some(script) });
  }
  return steps;
}

function installCommand(install: Install, spec: string): string[] {
  if (install.scope === "global") {
    if (install.packageManager === "bun") return ["bun", "add", "--no-cache", "-g", spec];
    if (install.packageManager === "pnpm") return ["pnpm", "add", "-g", spec];
    if (install.packageManager === "yarn") return ["yarn", "global", "add", spec];
    return ["npm", "install", "-g", spec];
  }
  if (install.packageManager === "bun") return ["bun", "add", "--no-cache", spec];
  if (install.packageManager === "pnpm") return ["pnpm", "add", spec];
  if (install.packageManager === "yarn") return ["yarn", "add", spec];
  return ["npm", "install", spec];
}

const quoteSh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** A POSIX shell script running the steps in `cwd`, stopping at the first failure with its exit code. */
export function shellScript(steps: ReadonlyArray<InstallStep>, cwd: string): string {
  return [
    `cd ${quoteSh(cwd)} || exit 1`,
    ...steps.map((step) => {
      const run = `echo ${quoteSh(`Running: ${step.argv.join(" ")}`)}; ${step.argv.map(quoteSh).join(" ")} || exit $?`;
      return Option.match(step.onlyIfExists, {
        onNone: () => run,
        onSome: (file) => `if [ -e ${quoteSh(file)} ]; then ${run}; fi`,
      });
    }),
  ].join("\n");
}

const quotePowerShell = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * A PowerShell program that waits for process `pid` to exit, then runs the steps in `cwd`. On the first
 * failure it runs `afterFailure`, if any, and exits with the failing step's code.
 */
export function powerShellProgram(input: {
  readonly steps: ReadonlyArray<InstallStep>;
  readonly cwd: string;
  readonly pid: number;
  readonly afterFailure: Option.Option<ReadonlyArray<string>>;
}): string {
  const onFailure = Option.match(input.afterFailure, {
    onNone: () => "",
    onSome: (argv) => `& ${argv.map(quotePowerShell).join(" ")}; `,
  });
  const steps = input.steps.flatMap((step) => {
    const run = `& ${step.argv.map(quotePowerShell).join(" ")}; if ($LASTEXITCODE -ne 0) { $code = $LASTEXITCODE; ${onFailure}exit $code }`;
    const script = Option.match(step.onlyIfExists, {
      onNone: () => run,
      onSome: (file) => `if (Test-Path -LiteralPath ${quotePowerShell(file)}) { ${run} }`,
    });
    return [`Write-Host ${quotePowerShell(`Running: ${step.argv.join(" ")}`)}`, script];
  });
  return [
    "$ErrorActionPreference = 'Stop'",
    "Write-Host 'Waiting for the current process to exit before upgrading...'",
    `while (Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }`,
    `Set-Location -LiteralPath ${quotePowerShell(input.cwd)}`,
    ...steps,
  ].join("; ");
}
