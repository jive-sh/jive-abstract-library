import { expect, test } from "bun:test";
import { Effect, Option, pipe } from "effect";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "./impl";

test("findExecutable finds an installed command and returns none for a missing one", async () => {
  const { found, missing } = await Effect.runPromise(pipe(
    effunct(function* () {
      const osPlatform = yield* libraryModules.OSPlatform;
      return {
        found: yield* osPlatform.findExecutable("sh"),
        missing: yield* osPlatform.findExecutable("no-such-command-anywhere"),
      };
    })(),
    Effect.provide(OSPlatformImpl.Layer),
  ));
  expect(Option.isSome(found) && found.value.endsWith("/sh")).toBe(true);
  expect(missing).toEqual(Option.none());
});

test("spawnProcess without an env gives the child this process's environment as it is now", async () => {
  process.env["JIVE_SPAWN_TEST"] = "set after start";
  try {
    const { stdout } = await Effect.runPromise(pipe(
      effunct(function* () {
        const osPlatform = yield* libraryModules.OSPlatform;
        return yield* osPlatform.spawnProcess({ command: "sh", args: ["-c", "printf %s \"$JIVE_SPAWN_TEST\""] });
      })(),
      Effect.provide(OSPlatformImpl.Layer),
    ));
    expect(stdout).toBe("set after start");
  } finally {
    delete process.env["JIVE_SPAWN_TEST"];
  }
});
