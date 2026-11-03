import { expect, test } from "bun:test";
import { Effect, Logger, pipe, type Layer } from "effect";
import { stderrLogger, terminalLogger } from "./logger";

type Written = { readonly stream: "stdout" | "stderr"; readonly text: string };

/** Runs the effect with the logger under test and returns what it wrote, with the real streams restored after. */
async function logWith(layer: Layer.Layer<never>, effect: Effect.Effect<void>): Promise<ReadonlyArray<Written>> {
  const written: Array<Written> = [];
  const originals = { stdout: process.stdout.write, stderr: process.stderr.write };
  for (const stream of ["stdout", "stderr"] as const) {
    process[stream].write = ((text: string) => { written.push({ stream, text }); return true; }) as typeof process.stdout.write;
  }
  try {
    await Effect.runPromise(pipe(effect, Effect.provide(layer)));
  } finally {
    process.stdout.write = originals.stdout;
    process.stderr.write = originals.stderr;
  }
  return written;
}

test("the terminal logger prints info alone on stdout and prefixes other levels, errors on stderr", async () => {
  const written = await logWith(terminalLogger, Effect.gen(function* () {
    yield* Effect.log("cloned", { repo: "jive" });
    yield* Effect.logWarning("two\nlines");
    yield* Effect.logError("broken");
  }));
  // The test runner's streams are not terminals, so no color codes are written.
  expect(written).toEqual([
    { stream: "stdout", text: "cloned { repo: 'jive' }\n" },
    { stream: "stdout", text: " WARN: two\n WARN: lines\n" },
    { stream: "stderr", text: "ERROR: broken\n" },
  ]);
});

test("the hook logger prints every level's message alone on stderr", async () => {
  const written = await logWith(Logger.layer([stderrLogger]), Effect.gen(function* () {
    yield* Effect.log("building", 3);
    yield* Effect.logError("broken");
  }));
  expect(written).toEqual([
    { stream: "stderr", text: "building 3\n" },
    { stream: "stderr", text: "broken\n" },
  ]);
});

test("the terminal logger ends quietly when its reader stops early, as in `cli list | head -1`", async () => {
  const loggerPath = new URL("./logger.ts", import.meta.url).pathname;
  const program = `import { Effect, pipe } from "effect";
import { terminalLogger } from ${JSON.stringify(loggerPath)};
await Effect.runPromise(pipe(Effect.forEach(Array.from({ length: 20000 }, (_, i) => i), (i) => Effect.log("line " + i)), Effect.provide(terminalLogger)));`;
  const child = Bun.spawn(["bun", "-e", program], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  await reader.read();
  await reader.cancel();
  expect({ exitCode: await child.exited, stderr: await new Response(child.stderr).text() }).toEqual({ exitCode: 0, stderr: "" });
});
