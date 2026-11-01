import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Option, Result } from "effect";
import { JIVE_CLI_PACKAGE } from "../modules/jive-server/jive-cli";
import { publishPackage } from "./release";

/**
 * publishPackage when Jive refuses to provision the package: the refusal must stop it before anything is packed or
 * published. Provisioning runs the jive CLI (`bun x @jive-sh/jive@… login --cicd`, then `… provision …`), so a fake
 * `bun` first on PATH stands in for it: it records each command, signs in, and refuses the provision. publishPackage
 * composes its own layer, as every abstract calling it does, so the fake is reached through the environment.
 */

const scratch = mkdtempSync(join(tmpdir(), "release-test-"));
const commandLog = join(scratch, "commands.log");
const fakeBin = join(scratch, "bin");
const fakeBun = join(fakeBin, "bun");
mkdirSync(fakeBin);
writeFileSync(fakeBun, `#!/bin/sh\necho "$*" >> "${commandLog}"\n[ "$3" = provision ] && { echo "Jive refused: @test/client is provisioned for another code repository" >&2; exit 1; }\nexit 0\n`);
chmodSync(fakeBun, 0o755);

/** Requests that reached the package's registry, had publishing got that far. */
let registryRequests = 0;
const registry = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    registryRequests += 1;
    return new Response("refused by the test", { status: 403 });
  },
});

const originalPath = process.env["PATH"];
afterEach(() => { process.env["PATH"] = originalPath; });
afterAll(() => {
  registry.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});

test("a package Jive refuses is neither packed nor published", async () => {
  process.env["PATH"] = `${fakeBin}${delimiter}${originalPath}`;
  const packageDir = mkdtempSync(join(scratch, "package-"));
  const outDir = mkdtempSync(join(scratch, "out-"));
  // The package publishes to this fake, so even a publishPackage that skipped Jive could never reach npm.
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@test/client",
    version: "0.0.0",
    publishConfig: { registry: `http://127.0.0.1:${registry.port}/` },
  }));

  const result = await Effect.runPromise(Effect.result(publishPackage({
    packageDir,
    outDir,
    version: "1.0.0",
    distTag: "latest",
    provisionWithJive: Option.some({ serverUrl: "https://api.jive.sh" }),
  })));

  expect(Result.isFailure(result) && result.failure).toContain("could not provision @test/client");
  expect(Result.isFailure(result) && result.failure).toContain("nothing was published");
  expect(readFileSync(commandLog, "utf8").trim().split("\n")).toEqual([
    `x ${JIVE_CLI_PACKAGE} login --cicd`,
    `x ${JIVE_CLI_PACKAGE} provision connector-package-registry @test/client --instance {"packageName":"@test/client"}`,
  ]);
  expect(registryRequests).toBe(0);
  expect(readdirSync(outDir)).toEqual([]);
});
