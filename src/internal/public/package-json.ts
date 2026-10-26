import { Effect, FileSystem, Schema, SchemaIssue, pipe } from "effect";

const PACKAGE_JSON_FILE = "package.json";

const formatSchemaError = SchemaIssue.makeFormatterDefault();

/**
 * Reads the working directory's package.json and decodes it against an abstract's manifest schema, so every
 * abstract reports a missing file, malformed JSON and a schema mismatch with the same messages. Keys the
 * schema does not model are ignored, since a package.json carries fields no abstract owns.
 */
export function loadPackageJson<A, I>(
  schema: Schema.Codec<A, I, never, never>,
): Effect.Effect<A, string, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const text = yield* pipe(
      (yield* FileSystem.FileSystem).readFileString(PACKAGE_JSON_FILE),
      Effect.mapError((e) => `Cannot read ${PACKAGE_JSON_FILE}: ${e.message}`),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => `${PACKAGE_JSON_FILE} is not valid JSON: ${(e as Error).message}`,
    });
    return yield* pipe(
      Schema.decodeUnknownEffect(schema, { onExcessProperty: "ignore" })(parsed),
      Effect.catchTag("SchemaError", (e) =>
        Effect.fail(`${PACKAGE_JSON_FILE} does not match the abstract's schema:\n${formatSchemaError(e.issue)}`)),
    );
  });
}
