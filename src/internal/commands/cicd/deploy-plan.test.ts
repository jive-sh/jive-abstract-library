import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { DeployPlan } from "../../public/deploy-plan";
import { PIPELINE_CONTEXT_EXAMPLE } from "../../common/pipeline-context";

const ENTRYPOINT = resolve(import.meta.dir, "../../../entrypoints/jive-library.ts");
const NAME = "jive-deploy-plan-test";

/** A registry that lists `NAME` at 1.0.0 only, which the built package points npm at through `publishConfig`. */
const registry = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => new URL(request.url).pathname === `/${NAME}`
    ? Response.json({
      name: NAME,
      "dist-tags": { latest: "1.0.0" },
      versions: { "1.0.0": { name: NAME, version: "1.0.0", dist: { tarball: `http://127.0.0.1/${NAME}-1.0.0.tgz` } } },
      time: { "1.0.0": "2026-10-26T00:00:00.000Z" },
    })
    : new Response("{}", { status: 404 }),
});
afterAll(() => { registry.stop(true); });

/** Runs the `deploy-plan` hook in a workspace whose build stamped `version`, returning its exit code and output. */
async function deployPlan(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "deploy-plan-test-"));
  mkdirSync(join(dir, "dist", "base"), { recursive: true });
  writeFileSync(join(dir, "dist", "base", "package.json"), JSON.stringify({
    name: NAME,
    version: `${version}-local`,
    publishConfig: { registry: `http://127.0.0.1:${registry.port}/` },
  }));
  // Async spawn: the fake registry is served from this process, so a synchronous spawn would block it.
  const child = Bun.spawn(["bun", ENTRYPOINT, "cicd", "deploy-plan"], {
    cwd: dir,
    env: { ...process.env, JIVE_DEPLOY_ENVIRONMENT: "latest", JIVE_PIPELINE_CONTEXT: JSON.stringify(PIPELINE_CONTEXT_EXAMPLE) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exitCode };
}

test("prints only {\"deploy\":false} when the registry already lists this version", async () => {
  const { stdout, stderr, exitCode } = await deployPlan("1.0.0");
  expect({ exitCode, stdout }).toEqual({ exitCode: 0, stdout: '{"deploy":false}\n' });
  expect(stderr).toContain(`${NAME}@1.0.0 is already on http://127.0.0.1:${registry.port}/`);
}, 60_000);

test("prints only the plan to publish, with the version's npm page, when it does not", async () => {
  const { stdout, exitCode } = await deployPlan("1.0.1");
  expect({ exitCode, stdout }).toEqual({
    exitCode: 0,
    stdout: `{"deploy":true,"url":"https://www.npmjs.com/package/${NAME}/v/1.0.1"}\n`,
  });
  expect(Schema.decodeUnknownSync(DeployPlan)(JSON.parse(stdout))).toEqual({ deploy: true, url: `https://www.npmjs.com/package/${NAME}/v/1.0.1` });
}, 60_000);
