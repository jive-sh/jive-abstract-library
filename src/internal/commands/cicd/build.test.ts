import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, pipe } from "effect";
import { effunct } from "effective-modules";
import { BuilderImpl } from "../../modules/builder/impl";
import { DeployerImpl } from "../../modules/deployer/impl";
import { JsonSchemaImpl } from "../../modules/json-schema/impl";
import { PACKAGE_SCHEMA_FILE } from "../../common/constants";
import { buildAndInstall } from "./build";

const SCRATCH = join(import.meta.dir, "..", "..", "..", "..", ".scratch", "build-writes-package-schema");

test("a build writes package.schema.json and points package.json's $schema at it", async () => {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, "package.json"), `${JSON.stringify({ name: "@acme/widget", version: "0.1.0" }, null, 2)}\n`);
  const steps: string[] = [];
  const previous = process.cwd();
  process.chdir(SCRATCH);
  try {
    await Effect.runPromise(pipe(
      effunct(buildAndInstall)(),
      Effect.provide(pipe(
        Layer.mergeAll(
          BuilderImpl.mockLayer({ *build() { steps.push("build"); return { platforms: [] }; } }),
          DeployerImpl.mockLayer({ *deploy() { steps.push("install"); } }),
          JsonSchemaImpl.Layer,
        ),
        Layer.provideMerge(BunFileSystem.layer),
      )),
    ));
  } finally {
    process.chdir(previous);
  }
  expect(steps).toEqual(["build", "install"]);
  expect(existsSync(join(SCRATCH, PACKAGE_SCHEMA_FILE))).toBe(true);
  expect(JSON.parse(readFileSync(join(SCRATCH, PACKAGE_SCHEMA_FILE), "utf8")).$schema).toBe("http://json-schema.org/draft-07/schema#");
  expect(JSON.parse(readFileSync(join(SCRATCH, "package.json"), "utf8")).$schema).toBe(`./${PACKAGE_SCHEMA_FILE}`);
  rmSync(SCRATCH, { recursive: true, force: true });
});
