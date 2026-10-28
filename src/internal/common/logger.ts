import { Logger, type LogLevel } from "effect";
import { inspect, styleText } from "node:util";

/** Hook output the pipeline parses is the process's stdout, so log lines must go to stderr. */
export const stderrLogger = Logger.make(({ message }) => {
  process.stderr.write(`${formatMessage(message)}\n`);
});

/**
 * Replaces Effect's default logger, whose lines carry timestamps and fiber ids, with lines for a person at a
 * terminal: an info line is the message alone, every other level is prefixed with its name, errors go to stderr
 * and the rest to stdout, and each level has its own color when the stream is a terminal.
 */
export const terminalLogger = Logger.layer([Logger.make(({ logLevel, message }) => {
  const stream = logLevel === "Error" || logLevel === "Fatal" ? process.stderr : process.stdout;
  const prefix = logLevel === "Info" ? "" : `${logLevel.toUpperCase().padStart(5)}: `;
  const lines = formatMessage(message).split("\n").map((line) => `${prefix}${line}`).join("\n");
  stream.write(`${stream.isTTY ? styleForLevel(logLevel, lines) : lines}\n`);
})]);

function styleForLevel(level: LogLevel.LogLevel, text: string): string {
  switch (level) {
    case "Trace":
    case "Debug":
      return styleText("dim", text);
    case "Warn":
      return styleText("yellow", text);
    case "Error":
      return styleText("red", text);
    case "Fatal":
      return styleText(["bold", "red"], text);
    default:
      return text;
  }
}

/** `Effect.log("a", 1)` logs an array; each part is printed as a person would read it, joined by spaces. */
function formatMessage(message: unknown): string {
  return (Array.isArray(message) ? message : [message]).map(formatPart).join(" ");
}

function formatPart(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return inspect(value, { depth: null, colors: false });
}
