import { Schema } from "effect";

/**
 * The shape a package.json must have to be built and published by this template.
 *
 * This is the template's entire public surface: the watch daemon turns it into the JSON Schema
 * written beside a package's own package.json, which that package points its `$schema` field at,
 * and the `cicd` commands decode against it at runtime.
 */

/** Fields the builder generates into the published manifests, so a source package.json must not set them. */
export const GENERATED_PACKAGE_JSON_FIELDS = ["files", "exports", "repository"] as const;

/** The CI/CD hooks Jive's reusable pipeline invokes; every one must be defined. */
export const REQUIRED_SCRIPTS = [
  "jive:cicd:get-config",
  "jive:cicd:build",
  "jive:cicd:audit",
  "jive:cicd:deploy:url",
  "jive:cicd:upload-artifacts",
  "jive:cicd:deploy",
] as const;

/** Deploy environment that installs the build locally instead of publishing it. */
export const LOCAL_ENVIRONMENT = "local";

/** Deploy environment whose version is pinned to the commit that produced it. */
export const PREVIEW_ENVIRONMENT = "preview";

/** Deploy environment published under npm's default dist-tag, with no prerelease on the base package. */
export const LATEST_ENVIRONMENT = "latest";

/** Environments the pipeline owns; a package cannot claim them as its own deploy targets. */
export const RESERVED_ENVIRONMENTS = [LOCAL_ENVIRONMENT, PREVIEW_ENVIRONMENT] as const;

export function isEnvironment(name: string, environment: string): boolean {
  return name.toLowerCase() === environment;
}

/**
 * Matches a name case-insensitively without a regex flag, since JSON Schema's `pattern` is applied
 * without one — the generated schema has to carry the same rule the decoder does.
 */
function caseInsensitivePattern(name: string): string {
  return [...name].map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join("");
}

const reservedEnvironmentPattern = new RegExp(
  `^(?!(?:${RESERVED_ENVIRONMENTS.map(caseInsensitivePattern).join("|")})$).+$`,
);

const reservedEnvironmentMessage =
  `${RESERVED_ENVIRONMENTS.map((name) => `"${name}"`).join(" and ")} are reserved by the pipeline and cannot be deploy environments`;

/**
 * A deploy target. One check serves both validators: the decoder runs the predicate, and the
 * generated JSON Schema gets the equivalent pattern plus `patternErrorMessage`, a keyword VS Code
 * shows in place of the raw regex.
 */
const EnvironmentName = Schema.NonEmptyString
  .check(Schema.makeFilter(
    (name: string) =>
      RESERVED_ENVIRONMENTS.some((reserved) => isEnvironment(name, reserved))
        ? `"${name}": ${reservedEnvironmentMessage}`
        : undefined,
    {
      toJsonSchema: () => ({
        pattern: reservedEnvironmentPattern.source,
        patternErrorMessage: reservedEnvironmentMessage,
      }),
    },
  ))
  .annotate({
    description: 'A deploy target name, e.g. "Production" or "latest". "local" and "preview" are reserved.',
  });

const RunsOnLabels = Schema.Union([
  Schema.NonEmptyString,
  Schema.NonEmptyArray(Schema.NonEmptyString),
]);

/**
 * The `cicd` block. Every field is required: the schema is the list of options a package author
 * can see, so a default hidden in the tooling would be an option nobody knows exists. Templates
 * supply the sensible values in the package they scaffold.
 *
 * Exported for other Jive templates to embed rather than restate.
 */
export const CicdSchema = Schema.Struct({
  deploy: Schema.Struct({
    verb: Schema.NonEmptyString.annotate({
      description: 'Verb shown in the deploy job\'s display name, e.g. "Deploy to" or "Publish Tag".',
    }),
    branches: Schema.Record(
      Schema.String,
      Schema.NonEmptyArray(EnvironmentName),
    ).annotate({
      description: 'Maps each deployable branch to its ordered, non-empty list of target environments, e.g. {"main": ["Staging", "Production"]}. To stop a branch deploying, remove its entry. {} means this package never deploys on a branch push.',
    }),
    previews: Schema.Boolean.annotate({
      description: 'If true, a pull request run — or a manual run on a branch absent from deploy.branches — deploys a "Preview" environment after the build.',
    }),
    sequentially: Schema.Boolean.annotate({
      description: "If true, a branch's environments deploy one at a time, in the order listed, each waiting for the previous to finish. If false, they all deploy at once.",
    }),
  }),
  runsOnPullRequests: Schema.Boolean.annotate({
    description: "If true, opening or pushing to a pull request runs the build and audit pipeline, plus a preview deploy when deploy.previews is also true.",
  }),
  runsOn: Schema.Union([
    RunsOnLabels,
    // group and labels are individually optional because GitHub accepts either alone; this mirrors
    // its own runs-on type rather than adding a Jive option.
    Schema.Struct({
      group: Schema.NonEmptyString,
      labels: Schema.optionalKey(RunsOnLabels),
    }),
    Schema.Struct({
      group: Schema.optionalKey(Schema.NonEmptyString),
      labels: RunsOnLabels,
    }),
  ]).annotate({
    description: 'Runner for the build and deploy jobs: a string, a string array, or a {group, labels} object — the same shapes GitHub Actions\' own "runs-on" accepts.',
  }),
});
export type CicdConfig = Schema.Schema.Type<typeof CicdSchema>;

/**
 * The daemons a package ships, by `src/daemons/` file name without its extension.
 *
 * A list and not a map: there is nothing left to configure per daemon, because **where the package is
 * installed decides how many of its daemons exist**. The registration id is derived from the installed
 * package's directory, so a globally installed copy has one daemon and each project that installs its own
 * copy has its own — which is what the person installing it already decided, in the only place that can
 * honour the decision.
 *
 * An earlier version had each daemon declare `local` or `global` instead. That was a second source of truth
 * that disagreed with the real one: a `global` daemon installed into two projects registered once, pointing
 * at whichever installed last, so uninstalling the second took the first project's daemon away — the exact
 * failure `local` was there to prevent. A `local` daemon installed globally collapsed to one id anyway.
 *
 * The list still has to be written down, because it is not configuration: a file dropped into
 * `src/daemons/` would otherwise acquire a start-at-login registration on every user's machine without the
 * manifest ever saying so.
 */
const DaemonDeclarations = Schema.Array(Schema.NonEmptyString);

const daemonsDescription =
  'Every `src/daemons/` entry, by file name without its extension, e.g. ["ozy-signing-agent"]. The build fails if this and the files disagree. Each installed copy of the package gets its own registration, so how many daemons run is decided by where the package is installed, not here.';

/**
 * The `library` block — configuration owned by this template, as `cicd` is owned by the pipeline.
 *
 * `daemonNames` pins the rendered JSON Schema to exactly the daemons a package actually has: any order,
 * no duplicates, nothing missing and nothing extra. The decoded type is unchanged, so the same
 * `PackageJson` type describes both forms.
 *
 * Exported so other templates can embed it rather than restate it.
 */
export function makeLibrarySchema(daemonNames: ReadonlyArray<string>): typeof LibrarySchema {
  return Schema.Struct({
    daemons: DaemonDeclarations
      .annotate({ description: daemonsDescription })
      .check(Schema.makeFilter(() => undefined, {
        toJsonSchema: () => ({
          items: { enum: [...daemonNames] },
          uniqueItems: true,
          minItems: daemonNames.length,
          maxItems: daemonNames.length,
        }),
      })),
  }) as unknown as typeof LibrarySchema;
}

export const LibrarySchema = Schema.Struct({
  daemons: DaemonDeclarations.annotate({ description: daemonsDescription }),
});
export type LibraryConfig = Schema.Schema.Type<typeof LibrarySchema>;

/**
 * The `jive` block of a package.json — everything Jive owns in a consuming package's manifest,
 * and what `jive:cicd:get-config` prints. A template adds its own keys alongside `cicd`.
 */
export const JivePackageConfig = Schema.Struct({
  cicd: CicdSchema,
  library: LibrarySchema,
});
export type JivePackageConfig = Schema.Schema.Type<typeof JivePackageConfig>;

const requiredScriptFields = Object.fromEntries(
  REQUIRED_SCRIPTS.map((script) => [script, Schema.NonEmptyString]),
) as { readonly [Script in (typeof REQUIRED_SCRIPTS)[number]]: typeof Schema.NonEmptyString };

const generatedFields = Object.fromEntries(
  GENERATED_PACKAGE_JSON_FIELDS.map((field) => [field, Schema.optionalKey(Schema.Never)]),
) as { readonly [Field in (typeof GENERATED_PACKAGE_JSON_FIELDS)[number]]: Schema.optionalKey<typeof Schema.Never> };

function packageJsonFields(library: typeof LibrarySchema) {
  return {
    $schema: Schema.NonEmptyString.annotate({
      description: "Path to this package's generated schema, ./package.schema.json. The watch daemon writes that file and sets this field.",
    }),
    name: Schema.NonEmptyString.check(Schema.isPattern(/^(?:@[^/]+\/[^/]+|(?!@)[^/]+)$/)),
    version: Schema.NonEmptyString,
    license: Schema.NonEmptyString,
    description: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
    type: Schema.OptionFromOptionalKey(Schema.Literal("module")),
    scripts: Schema.StructWithRest(
      Schema.Struct(requiredScriptFields),
      [Schema.Record(Schema.String, Schema.String)],
    ),
    dependencies: Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.String)),
    peerDependencies: Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.String)),
    peerDependenciesMeta: Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown))),
    publishConfig: Schema.OptionFromOptionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    jive: Schema.Struct({ cicd: CicdSchema, library }),
    ...generatedFields,
  };
}

/**
 * This template's package.json schema, narrowed to the daemons a package actually ships.
 *
 * This is the function a template's `genPackageJsonSchema` hook ultimately returns: given the daemon
 * entrypoints found on disk, it yields the schema that makes declaring them mandatory.
 */
export function makePackageJsonSchema(daemonNames: ReadonlyArray<string>): typeof PackageJsonSchema {
  return Schema.Struct(packageJsonFields(makeLibrarySchema(daemonNames))) as unknown as typeof PackageJsonSchema;
}

export const PackageJsonSchema = Schema.Struct(packageJsonFields(LibrarySchema));
export type PackageJson = Schema.Schema.Type<typeof PackageJsonSchema>;
