import { Logger } from "effect";

/** Hook output the pipeline parses is the process's stdout, so log lines must go to stderr. */
export const stderrLogger = Logger.make(({ message }) => {
  process.stderr.write(`${Array.isArray(message) ? message.join(" ") : String(message)}\n`);
});
