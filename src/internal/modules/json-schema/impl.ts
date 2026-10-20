import { Effect, FileSystem, JsonSchema, Schema, pipe } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { resolve } from "node:path";
import { PACKAGE_SCHEMA_FILE } from "../../common/constants";
import { editJsonc } from "../../common/jsonc";
import { GENERATED_PACKAGE_JSON_FIELDS } from "../../public/manifest";
import { libraryModules } from "../index";
import type { IJsonSchema } from "./interface";

export class JsonSchemaImpl extends implementing(libraryModules.JsonSchema)
  .uses(FileSystem.FileSystem)
  implements IJsonSchema {

  *render(schema: Schema.Top): EffectGen<string> {
    return yield* Effect.sync(() => {
      const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema));
      const rendered = banGeneratedFields(allowAdditionalProperties(withMetaSchema(normalizeArrays({
        ...document.schema,
        ...(Object.keys(document.definitions).length === 0 ? {} : { definitions: document.definitions }),
      }))));
      return `${JSON.stringify(rendered, null, 2)}\n`;
    });
  }

  *writePackageSchema(rootDir: string, schema: Schema.Top): EffectGen<boolean, string> {
    const fs = this.getDependency(FileSystem.FileSystem);
    const schemaPath = resolve(rootDir, PACKAGE_SCHEMA_FILE);
    const rendered = yield* this.render(schema);

    const previous = (yield* this.fsOp(fs.exists(schemaPath)))
      ? yield* this.fsOp(fs.readFileString(schemaPath))
      : "";
    if (previous !== rendered) {
      yield* this.fsOp(fs.writeFileString(schemaPath, rendered));
    }

    const packageJsonPath = resolve(rootDir, "package.json");
    const originalText = yield* this.fsOp(fs.readFileString(packageJsonPath));
    const updatedText = yield* editJsonc(packageJsonPath, originalText, [
      { path: ["$schema"], value: `./${PACKAGE_SCHEMA_FILE}`, insertAt: () => 0 },
    ]);
    if (updatedText !== originalText) {
      yield* this.fsOp(fs.writeFileString(packageJsonPath, updatedText));
    }

    return previous !== rendered || updatedText !== originalText;
  }

  private fsOp<A>(effect: Effect.Effect<A, { readonly message: string }>): Effect.Effect<A, string> {
    return pipe(effect, Effect.mapError((e) => e.message));
  }
}

function withMetaSchema(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  return { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_07, ...schema };
}

/** A real package.json carries many fields this template does not model; they must not be errors. */
function allowAdditionalProperties(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  return { ...schema, additionalProperties: true };
}

/**
 * Effect renders a `never`-typed field as `{}`, which accepts anything — correct for its own
 * decoder, useless in an editor. Draft-07's boolean `false` schema is what actually rejects the key.
 */
function banGeneratedFields(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const properties = (schema as { properties?: Record<string, unknown> }).properties;
  if (!properties) return schema;
  return {
    ...schema,
    properties: {
      ...properties,
      ...Object.fromEntries(GENERATED_PACKAGE_JSON_FIELDS.map((field) => [field, false])),
    },
  } as JsonSchema.JsonSchema;
}

/**
 * Effect emits a single-element `items` tuple plus a matching `additionalItems` for homogeneous
 * arrays; draft-07 consumers expect the simpler single-schema `items` form.
 */
function normalizeArrays(schema: JsonSchema.JsonSchema): JsonSchema.JsonSchema {
  const normalized = normalizeNode(schema);
  if (!isObject(normalized)) throw new Error("expected the generated JSON Schema root to be an object");
  return normalized as JsonSchema.JsonSchema;
}

function normalizeNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeNode);
  if (!isObject(value)) return value;

  const normalized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeNode(child);
  }

  const items = normalized["items"];
  const additionalItems = normalized["additionalItems"];
  if (
    normalized["type"] === "array"
    && Array.isArray(items)
    && items.length === 1
    && additionalItems !== undefined
    && JSON.stringify(items[0]) === JSON.stringify(additionalItems)
  ) {
    normalized["items"] = items[0];
    delete normalized["additionalItems"];
  }

  return normalized;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
