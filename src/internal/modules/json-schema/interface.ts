import type { Schema } from "effect";
import type { EffectGen } from "effective-modules";

export interface IJsonSchema {
  /** Renders a schema as a draft-07 JSON Schema document, with the adjustments editors need. */
  render(schema: Schema.Top): EffectGen<string>;
  /**
   * Writes the rendered schema beside a package's own package.json and points its `$schema` at it,
   * reporting whether anything changed. A sibling file rather than one under node_modules, because
   * editors watch the workspace but not node_modules, so a schema there goes stale after every rebuild.
   */
  writePackageSchema(rootDir: string, schema: Schema.Top): EffectGen<boolean, string>;
}
