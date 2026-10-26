import { expect, test } from "bun:test";
import { Effect, Result, Schema } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeJivePackageJsonSchema } from "./manifest";
import { loadPackageJson } from "./package-json";

const OtherAbstractSchema = makeJivePackageJsonSchema({
  "other-abstract": Schema.Struct({ project: Schema.NonEmptyString }),
});

const manifest = {
  $schema: "./package.schema.json",
  name: "@example/backend",
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
  private: true,
  jive: {
    cicd: {
      deploy: { verb: "Deploy to", branches: { main: ["Production"] }, previews: false, sequentially: true },
      runsOnPullRequests: true,
      runsOn: "ubuntu-latest",
    },
    "other-abstract": { project: "example" },
  },
};

function loadFrom(contents: string) {
  const rootDir = mkdtempSync(join(tmpdir(), "jive-package-json-"));
  writeFileSync(join(rootDir, "package.json"), contents);
  const previous = process.cwd();
  process.chdir(rootDir);
  return Effect.runPromise(Effect.result(loadPackageJson(OtherAbstractSchema).pipe(Effect.provide(BunFileSystem.layer))))
    .finally(() => process.chdir(previous));
}

test("another abstract's block decodes beside cicd", async () => {
  const result = await loadFrom(JSON.stringify(manifest));
  expect(Result.isSuccess(result) && result.success.jive["other-abstract"].project).toBe("example");
});

test("a missing hook is reported by name", async () => {
  const { "jive:cicd:deploy": _deploy, ...scripts } = manifest.scripts;
  const result = await loadFrom(JSON.stringify({ ...manifest, scripts }));
  expect(Result.isFailure(result) && result.failure).toContain("jive:cicd:deploy");
});

test("malformed JSON names the file rather than throwing", async () => {
  const result = await loadFrom("{ not json");
  expect(Result.isFailure(result) && result.failure).toContain("package.json is not valid JSON");
});

test("a reserved environment name is rejected for every abstract, not only the library", () => {
  const withLocal = { ...manifest, jive: { ...manifest.jive, cicd: { ...manifest.jive.cicd, deploy: { ...manifest.jive.cicd.deploy, branches: { main: ["local"] } } } } };
  expect(() => Schema.decodeUnknownSync(OtherAbstractSchema)(withLocal)).toThrow(/reserved/);
});
