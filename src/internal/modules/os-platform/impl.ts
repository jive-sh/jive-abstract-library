import { Effect, Option } from "effect";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules } from "../index";
import type {
  CompileExecutableInput,
  DetachedProcessInput,
  IOSPlatform,
  ProcessResult,
  SpawnProcessInput,
} from "./interface";

export class OSPlatformImpl extends implementing(libraryModules.OSPlatform) implements IOSPlatform {
  *spawnProcess(input: SpawnProcessInput): EffectGen<ProcessResult, string> {
    return yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([input.command, ...(input.args ?? [])], {
          cwd: input.cwd,
          env: input.env,
          stdin: input.stdin ?? "ignore",
          stdout: input.stdout ?? "pipe",
          stderr: input.stderr ?? "pipe",
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
          proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
        ]);
        return { exitCode, stdout, stderr };
      },
      catch: (e) => `Failed to run ${input.command}: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  *runDetached(input: DetachedProcessInput): EffectGen<number, string> {
    return yield* Effect.callback<number, string>((resume) => {
      const child = spawnDetached(input);
      child.once("error", (e) => resume(Effect.fail(`Failed to run ${input.command}: ${e.message}`)));
      child.once("exit", (code, signal) => resume(code !== null
        ? Effect.succeed(code)
        : Effect.fail(`${input.command} was stopped by ${signal}`)));
    });
  }

  *startDetached(input: DetachedProcessInput): EffectGen<void, string> {
    return yield* Effect.callback<void, string>((resume) => {
      const child = spawnDetached(input);
      child.once("error", (e) => resume(Effect.fail(`Failed to start ${input.command}: ${e.message}`)));
      child.once("spawn", () => {
        child.unref();
        resume(Effect.void);
      });
    });
  }

  /**
   * Compiles in a child process rather than through `Bun.build` in this one.
   *
   * Each compiled binary embeds the Bun runtime and runs to ~100MB. Building five platforms in a single
   * process never returns that memory, so the fourth or fifth target dies with
   * `error.OutOfMemory: Error writing standalone module graph` on any machine without several spare
   * gigabytes. A child process gives it all back on exit, and the cost is one spawn per platform.
   */
  *compileExecutable(input: CompileExecutableInput): EffectGen<void, string> {
    const result = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([
          "bun", "build",
          "--compile",
          "--target", input.target,
          "--outfile", input.outfile,
          "--root", input.root,
          "--sourcemap=inline",
          input.entrypoint,
        ], { stdout: "pipe", stderr: "pipe" });
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { exitCode, output: [stdout, stderr].join("\n").trim() };
      },
      catch: (e) => `Failed to compile ${input.target}: ${e instanceof Error ? e.message : String(e)}`,
    });
    if (result.exitCode !== 0) {
      return yield* Effect.fail(`Failed to compile ${input.target}:\n${result.output}`);
    }
  }

  *getCurrentDirectory(): EffectGen<string> {
    return yield* Effect.sync(() => process.cwd());
  }

  *getCurrentPlatform(): EffectGen<{ readonly os: string; readonly cpu: string }> {
    return yield* Effect.sync(() => ({ os: process.platform, cpu: process.arch }));
  }

  *requireEnv(name: string): EffectGen<string, string> {
    const value = yield* Effect.sync(() => process.env[name]);
    if (!value) return yield* Effect.fail(`${name} is not set`);
    return value;
  }

  *readEnv(name: string): EffectGen<Option.Option<string>> {
    const value = yield* Effect.sync(() => process.env[name]);
    return value ? Option.some(value) : Option.none();
  }

  *getHomeDirectory(): EffectGen<string> {
    return yield* Effect.sync(() => homedir());
  }

  *getExecutablePath(): EffectGen<string> {
    // For a Bun single-file executable this is the binary as invoked, which for a daemon is the hard link
    // the installer made in the package's bin directory — exactly what its registration recorded.
    return yield* Effect.sync(() => process.execPath);
  }
}

/** `detached` gives the child its own session (setsid), and with it its own process group. */
function spawnDetached(input: DetachedProcessInput) {
  return spawn(input.command, [...input.args], { cwd: input.cwd, env: input.env, detached: true, stdio: "inherit" });
}
