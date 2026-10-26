import { describe, expect, test } from "bun:test";
import { Effect, JsonSchema, Option, Result, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverDaemonNames } from "./daemons";
import { makePackageJsonSchema, PackageJsonSchema } from "./manifest";

function daemonsNode(daemonNames: ReadonlyArray<string>): Record<string, any> {
  const schema = makePackageJsonSchema(daemonNames);
  const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(schema));
  return (document.schema as any).properties.jive.properties.library.properties.daemons;
}

test("the generated schema pins the list to exactly the daemons that exist", () => {
  const constraint = daemonsNode(["alpha", "beta"])["allOf"][0];
  expect(constraint.items.enum).toEqual(["alpha", "beta"]);
  expect(constraint.uniqueItems).toBe(true);
  // Bounded on both sides, so neither a missing nor a repeated name passes; order is left free.
  expect(constraint.minItems).toBe(2);
  expect(constraint.maxItems).toBe(2);
});

test("a package with no daemons gets a schema that accepts only an empty list", () => {
  const constraint = daemonsNode([])["allOf"][0];
  expect(constraint.items.enum).toEqual([]);
  expect(constraint.maxItems).toBe(0);
});

/**
 * The pinning is for the editor alone. The decoder runs in CI and inside a published binary, where
 * `src/daemons/` may not be present to read, so it must stay the looser shape — and one `PackageJson`
 * type has to describe both.
 */
function manifestWith(library: object) {
  return {
    $schema: "./package.schema.json",
    name: "example",
    version: "0.1.0",
    license: "MIT",
    scripts: {
      "jive:cicd:get-config": "x",
      "jive:cicd:build": "x",
      "jive:cicd:audit": "x",
      "jive:cicd:deploy:plan": "x",
      "jive:cicd:upload-artifacts": "x",
      "jive:cicd:deploy": "x",
    },
    jive: {
      cicd: {
        deploy: { verb: "Publish", branches: {}, previews: false, sequentially: true },
        runsOnPullRequests: true,
        runsOn: "ubuntu-latest",
      },
      library,
    },
  };
}

test("pinning the schema does not narrow what it decodes", () => {
  const manifest = manifestWith({ daemons: ["unlisted"], provisionWithJive: null });
  for (const schema of [PackageJsonSchema, makePackageJsonSchema(["alpha"])]) {
    expect(Schema.decodeUnknownSync(schema)(manifest).jive.library.daemons).toEqual(["unlisted"]);
  }
});

test("daemon discovery reads src/daemons, sorted, ignoring tests and non-sources", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "jive-daemons-"));
  mkdirSync(join(rootDir, "src", "daemons"), { recursive: true });
  for (const file of ["beta.ts", "alpha.ts", "alpha.test.ts", "notes.md"]) {
    writeFileSync(join(rootDir, "src", "daemons", file), "");
  }

  const names = await Effect.runPromise(
    discoverDaemonNames(rootDir).pipe(Effect.provide(BunFileSystem.layer)),
  );
  expect(names).toEqual(["alpha", "beta"]);
});

test("a package without src/daemons has no daemons rather than failing", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "jive-daemons-"));
  const names = await Effect.runPromise(
    discoverDaemonNames(rootDir).pipe(Effect.provide(BunFileSystem.layer)),
  );
  expect(names).toEqual([]);
});

describe("provisionWithJive", () => {
  const decode = (provisionWithJive: unknown) =>
    Schema.decodeUnknownResult(PackageJsonSchema)(manifestWith({ daemons: [], provisionWithJive }));

  test("null decodes to none and encodes back to null", () => {
    const decoded = Schema.decodeUnknownSync(PackageJsonSchema)(manifestWith({ daemons: [], provisionWithJive: null }));
    expect(decoded.jive.library.provisionWithJive).toEqual(Option.none());
    expect((Schema.encodeSync(PackageJsonSchema)(decoded) as any).jive.library.provisionWithJive).toBeNull();
  });

  test("a server decodes to some, over https or plain http to this machine", () => {
    for (const serverUrl of ["https://api.jive.sh", "http://127.0.0.1:3210", "http://localhost:3210"]) {
      const result = decode({ serverUrl });
      expect(Result.isSuccess(result) && result.success.jive.library.provisionWithJive).toEqual(Option.some({ serverUrl }));
    }
  });

  test("is required, and refuses a relative URL or plain http elsewhere", () => {
    for (const provisionWithJive of [undefined, { serverUrl: "api.jive.sh" }, { serverUrl: "http://api.jive.sh" }]) {
      expect(Result.isFailure(decode(provisionWithJive))).toBe(true);
    }
  });

  test("the generated schema describes it, so an author can discover it", () => {
    const document = JsonSchema.toDocumentDraft07(Schema.toJsonSchemaDocument(makePackageJsonSchema([])));
    const node = (document.schema as any).properties.jive.properties.library;
    expect(node.required).toContain("provisionWithJive");
    expect(JSON.stringify(node.properties.provisionWithJive)).toContain("packages.provision");
    expect(JSON.stringify(node.properties.provisionWithJive)).toContain("The Jive server deployment's URL");
  });
});
