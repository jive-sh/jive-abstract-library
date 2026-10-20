import { Effect, FileSystem, Schema, SchemaIssue, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { PackageJsonSchema, type PackageJson } from "../../public/manifest";
import { libraryModules } from "../index";
import type { IPackage } from "./interface";

const PACKAGE_JSON_FILE = "package.json";

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class PackageImpl extends implementing(libraryModules.Package).uses(FileSystem.FileSystem) implements IPackage {
  *load(): EffectGen<PackageJson, string> {
    const text = yield* pipe(
      this.getDependency(FileSystem.FileSystem).readFileString(PACKAGE_JSON_FILE),
      Effect.mapError((e) => `Cannot read ${PACKAGE_JSON_FILE}: ${e.message}`),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (e) => `${PACKAGE_JSON_FILE} is not valid JSON: ${(e as Error).message}`,
    });
    return yield* pipe(
      Schema.decodeUnknownEffect(PackageJsonSchema, { onExcessProperty: "ignore" })(parsed),
      Effect.catchTag("SchemaError", (e) => Effect.fail(`${PACKAGE_JSON_FILE} does not match the template schema:\n${formatSchemaError(e.issue)}`)),
    );
  }

}
