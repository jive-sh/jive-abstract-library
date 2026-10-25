import type { EffectGen } from "effective-modules";

export type ProcessStdio = "pipe" | "inherit" | "ignore";

export interface SpawnProcessInput {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly stdin?: ProcessStdio;
  readonly stdout?: ProcessStdio;
  readonly stderr?: ProcessStdio;
}

/** A process run detached from this one, with this process's stdout and stderr. */
export interface DetachedProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IOSPlatform {
  /** Runs a host process to completion with explicit stdio behavior. */
  spawnProcess(input: SpawnProcessInput): EffectGen<ProcessResult, string>;
  /**
   * Runs a process in a session and process group of its own and waits for it to exit, returning its exit
   * code. A service manager stopping this process's group (launchd stopping a job) leaves it running.
   */
  runDetached(input: DetachedProcessInput): EffectGen<number, string>;
  /** Starts a process the way `runDetached` does and returns at once, so it can outlive this process. */
  startDetached(input: DetachedProcessInput): EffectGen<void, string>;
  /** Compiles an entrypoint into a standalone executable for one platform target. */
  compileExecutable(input: CompileExecutableInput): EffectGen<void, string>;
  /** Reads this process's current working directory. */
  getCurrentDirectory(): EffectGen<string>;
  /** The platform this process is running on, as an os/cpu pair. */
  getCurrentPlatform(): EffectGen<{ readonly os: string; readonly cpu: string }>;
  /** Reads an environment variable, failing when it is unset or empty. */
  requireEnv(name: string): EffectGen<string, string>;
  /** The current user's home directory, which is where per-user daemon state lives. */
  getHomeDirectory(): EffectGen<string>;
  /** This process's own executable, which is how a daemon recognises its own registration. */
  getExecutablePath(): EffectGen<string>;
}

export interface CompileExecutableInput {
  readonly entrypoint: string;
  readonly outfile: string;
  readonly target: string;
  readonly root: string;
}
