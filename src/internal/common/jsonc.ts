import { Effect } from "effect";
import type { EffectGen } from "effective-modules";
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";

/**
 * Editing a package's own JSON by patch rather than by reparse-and-rewrite: these files are hand-maintained,
 * so comments, key order and formatting all have to survive a tool touching one field.
 */
export const JSONC_FORMATTING_OPTIONS = {
  insertSpaces: true,
  tabSize: 2,
  eol: "\n",
  insertFinalNewline: true,
} as const satisfies FormattingOptions;

export interface JsoncEdit {
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
  /** Where the key goes when it is absent. Omit to append. */
  readonly insertAt?: (properties: readonly string[]) => number;
}

/** Applies every edit in order, failing if any of them would produce something that no longer parses. */
export function* editJsonc(filePath: string, originalText: string, edits: ReadonlyArray<JsoncEdit>): EffectGen<string, string> {
  let text = originalText;
  for (const edit of edits) {
    text = applyEdits(text, modify(text, [...edit.path], edit.value, {
      formattingOptions: JSONC_FORMATTING_OPTIONS,
      ...(edit.insertAt === undefined ? {} : { getInsertionIndex: edit.insertAt }),
    }));
  }
  yield* assertValidJsonc(filePath, text);
  return text;
}

/** Index just past `property`, so an inserted key lands where a reader expects it rather than at the end. */
export function insertAfter(properties: readonly string[], property: string): number {
  const index = properties.indexOf(property);
  return index === -1 ? properties.length : index + 1;
}

export function* assertValidJsonc(filePath: string, text: string): EffectGen<void, string> {
  const errors: ParseError[] = [];
  parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length === 0) return;

  const details = errors
    .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join(", ");
  return yield* Effect.fail(`${filePath} is invalid JSONC: ${details}`);
}
