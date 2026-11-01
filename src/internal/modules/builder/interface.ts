import type { EffectGen } from "effective-modules";

export interface Platform {
  readonly id: string;
  readonly target: string;
  readonly os: string;
  readonly cpu: string;
}

export const PLATFORMS = [
  { id: "darwin-arm64", target: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", target: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-arm64", target: "bun-linux-arm64", os: "linux", cpu: "arm64" },
  { id: "linux-x64", target: "bun-linux-x64", os: "linux", cpu: "x64" },
  { id: "windows-x64", target: "bun-windows-x64", os: "win32", cpu: "x64" },
] as const satisfies readonly Platform[];

/** Folder the base package is built into, alongside one folder per platform id. */
export const BASE_PACKAGE_DIR = "base";

export interface BuildInput {
  /** Build only the current machine's platform package, for a faster local turnaround. */
  readonly localOnly: boolean;
}

export interface BuildResult {
  /** Platform ids built, each of which has a folder of its own under dist/. */
  readonly platforms: ReadonlyArray<string>;
}

export interface IBuilder {
  /**
   * Lays out the package folders under dist/ — `base` plus one per platform — with every manifest
   * stamped at the local environment's version. Turning those into a release is the deployer's job.
   */
  build(input: BuildInput): EffectGen<BuildResult, string>;
  /**
   * The package's commands built with `Cli`, found by running each `src/entrypoints/` command from source with
   * `--completion-protocol`: one whose `Cli` speaks the protocol this builder's launcher uses prints it and exits
   * zero, so an older `Cli` (from another jive-abstract-library version) is left out rather than called with flags
   * it lacks. Daemons
   * are never run (running one starts it), and a command still running after 30 seconds is stopped and counted
   * as not built with `Cli`. The build bakes the result into the launcher stubs.
   */
  listCompletionCommands(rootDir: string): EffectGen<ReadonlyArray<string>, string>;
}
