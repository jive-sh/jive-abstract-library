import { Effect, Runtime, pipe } from "effect";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { version } from "../../package.json";
import { cicd } from "../internal/commands/cicd";
import { dev } from "../internal/commands/dev";
import { CLI_CMD_NAME } from "../internal/common/constants";
import { make, run } from "../internal/public/cli";

const jiveLibrary = make(CLI_CMD_NAME, { cicd, dev });

BunRuntime.runMain(pipe(run(jiveLibrary, { version }), Effect.provide(BunServices.layer)), {
  // Exit as soon as the command is done, whatever it leaves open (an HTTP client's idle connections): a
  // pipeline step waits for the process, not for the command.
  teardown: (exit, onExit) => Runtime.defaultTeardown(exit, (code) => {
    onExit(code);
    process.exit(code);
  }),
});
