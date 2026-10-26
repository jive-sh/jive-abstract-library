import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Result } from "effect";
import { publishPackage } from "./release";

/**
 * publishPackage against a fake GitHub token endpoint and a fake Jive server that refuses: the refusal must
 * stop it before anything is packed or published. The GitHub variables are set on this process because
 * publishPackage composes its own layer, as every abstract calling it does.
 */

let actionCalls = 0;
/** Requests that were neither for a token nor a call of the Jive server: npm's, had it got that far. */
let registryRequests = 0;
const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/token") return Response.json({ value: "id-token" });
    if (pathname !== "/api/action") {
      registryRequests += 1;
      return new Response("refused by the test", { status: 403 });
    }
    actionCalls += 1;
    return Response.json({ status: "success", value: { status: "refused", reason: "not a registered code repository" }, logLines: [] });
  },
});
afterAll(() => fake.stop(true));

const VARIABLES = ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN"] as const;
const saved = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));
afterEach(() => {
  for (const name of VARIABLES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("a package Jive refuses is neither packed nor published", async () => {
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = `http://127.0.0.1:${fake.port}/token?api-version=2.0`;
  process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
  const packageDir = mkdtempSync(join(tmpdir(), "release-test-package-"));
  const outDir = mkdtempSync(join(tmpdir(), "release-test-out-"));
  // The package publishes to this fake, so even a publishPackage that skipped Jive could never reach npm.
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({
    name: "@test/client",
    version: "0.0.0",
    publishConfig: { registry: `http://127.0.0.1:${fake.port}/` },
  }));

  const result = await Effect.runPromise(Effect.result(publishPackage({
    packageDir,
    outDir,
    version: "1.0.0",
    distTag: "latest",
    provisionWithJive: Option.some({ serverUrl: `http://127.0.0.1:${fake.port}` }),
  })));

  expect(Result.isFailure(result) && result.failure).toBe(
    "Jive refused to provision the npm package @test/client, so nothing was published: not a registered code repository",
  );
  expect(actionCalls).toBe(1);
  expect(registryRequests).toBe(0);
  expect(readdirSync(outDir)).toEqual([]);
});
