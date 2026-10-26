import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Fiber, Layer, Logger, Option, Result, pipe } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import { PipelineIdentityImpl } from "../pipeline-identity/impl";
import { JIVE_API_AUDIENCE, JiveServerImpl } from "./impl";

/**
 * Runs the real JiveServer and PipelineIdentity modules against two fakes this process serves: GitHub's ID
 * token endpoint, which hands out a new token per request, and a Convex deployment's `/api/action`, which
 * answers `packages:provision` with whatever each test queues.
 */

const REQUEST_TOKEN = "github-request-token";
const PACKAGE = "@test/demo";

let issued: string[] = [];
let tokenRequests: Array<{ audience: string | null; authorization: string | null; apiVersion: string | null }> = [];
let actionCalls: Array<{ authorization: string | null; body: any }> = [];
/** Answers of `/api/action`, in order; the last repeats. */
let answers: Array<{ status: number; body: string }> = [];

const fake = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/token") {
      tokenRequests.push({
        audience: url.searchParams.get("audience"),
        authorization: request.headers.get("authorization"),
        apiVersion: url.searchParams.get("api-version"),
      });
      const token = `id-token-${issued.length + 1}`;
      issued.push(token);
      return Response.json({ count: 1, value: token });
    }
    if (url.pathname === "/api/action" && request.method === "POST") {
      actionCalls.push({ authorization: request.headers.get("authorization"), body: await request.json() });
      const answer = answers[Math.min(actionCalls.length, answers.length) - 1]!;
      return new Response(answer.body, { status: answer.status, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => fake.stop(true));

const SERVER_URL = `http://127.0.0.1:${fake.port}`;
const success = (value: object) => ({ status: 200, body: JSON.stringify({ status: "success", value, logLines: [] }) });

beforeEach(() => {
  issued = [];
  tokenRequests = [];
  actionCalls = [];
  answers = [];
});

const githubEnv: Record<string, string> = {
  ACTIONS_ID_TOKEN_REQUEST_URL: `${SERVER_URL}/token?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

/**
 * Provisions `PACKAGE` with `env` as the job's environment, moving the clock on 10 seconds at a time up to
 * `advanceSeconds`; returns the outcome and every log line.
 */
async function provision(input: { env?: Record<string, string>; advanceSeconds?: number } = {}) {
  const env = input.env ?? githubEnv;
  const osPlatform = OSPlatformImpl.mockLayer({
    *readEnv(name: string) { return Option.fromUndefinedOr(env[name]); },
  });
  const logs: string[] = [];
  const capture = Logger.make(({ message }) => { logs.push(Array.isArray(message) ? message.join(" ") : String(message)); });
  const layer = pipe(
    JiveServerImpl.Layer,
    Layer.provideMerge(PipelineIdentityImpl.Layer),
    Layer.provideMerge(osPlatform),
    Layer.provideMerge(FetchHttpClient.layer),
  );
  const result = await Effect.runPromise(pipe(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(effunct(function* () {
        yield* (yield* libraryModules.JiveServer).provisionPackage({ serverUrl: SERVER_URL, registry: "npm", packageName: PACKAGE });
      })()));
      for (let advanced = 0; advanced < (input.advanceSeconds ?? 0); advanced += 10) {
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
        yield* TestClock.adjust(Duration.seconds(10));
      }
      return yield* Fiber.join(fiber);
    }),
    Effect.provide(layer),
    Effect.provide(TestClock.layer()),
    Effect.provide(Logger.layer([capture])),
  ));
  return { result, logs };
}

describe("provisionPackage", () => {
  test("calls packages:provision with a token GitHub minted for Jive's audience, and succeeds when ready", async () => {
    answers = [success({ status: "ready" })];
    const { result, logs } = await provision();
    expect(Result.isSuccess(result)).toBe(true);
    expect(tokenRequests).toEqual([{ audience: JIVE_API_AUDIENCE, authorization: `Bearer ${REQUEST_TOKEN}`, apiVersion: "2.0" }]);
    expect(actionCalls).toEqual([{
      authorization: "Bearer id-token-1",
      body: { path: "packages:provision", args: { registry: "npm", packageName: PACKAGE }, format: "json" },
    }]);
    expect(logs).toEqual([
      `Asking Jive at ${SERVER_URL} to provision the npm package ${PACKAGE}`,
      `Jive provisioned the npm package ${PACKAGE}; it is ready to publish`,
    ]);
  });

  test("while another deploy holds the package, asks again every 10 seconds with a fresh token", async () => {
    answers = [success({ status: "inProgress" }), success({ status: "inProgress" }), success({ status: "ready" })];
    const { result, logs } = await provision({ advanceSeconds: 30 });
    expect(Result.isSuccess(result)).toBe(true);
    expect(actionCalls.map((call) => call.authorization)).toEqual(["Bearer id-token-1", "Bearer id-token-2", "Bearer id-token-3"]);
    expect(logs).toContain(`  Another deploy is provisioning the npm package ${PACKAGE} (after 10s); asking again in 10 seconds`);
  });

  test("gives up after 10 minutes of another deploy holding the package", async () => {
    answers = [success({ status: "inProgress" })];
    const { result } = await provision({ advanceSeconds: 700 });
    expect(Result.isFailure(result) && result.failure).toBe(
      `After 10 minutes another deploy is still provisioning the npm package ${PACKAGE}, so nothing was published`,
    );
    // Asked at 0, 10, …, 600 seconds.
    expect(actionCalls).toHaveLength(61);
  });

  test("fails with Jive's reason when it refuses", async () => {
    answers = [success({ status: "refused", reason: "jive-sh/demo is not a registered code repository" })];
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toBe(
      `Jive refused to provision the npm package ${PACKAGE}, so nothing was published: jive-sh/demo is not a registered code repository`,
    );
  });

  test("fails with Convex's error when the function fails", async () => {
    answers = [{ status: 500, body: JSON.stringify({ status: "error", errorMessage: "Uncaught Error: Not authenticated", logLines: [] }) }];
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toBe(
      `Jive could not provision the npm package ${PACKAGE}, so nothing was published: Uncaught Error: Not authenticated`,
    );
  });

  test("fails, naming the answer, when the server's answer is not Convex's", async () => {
    answers = [{ status: 502, body: "Bad Gateway" }];
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toContain(`Cannot call packages:provision at ${SERVER_URL}: it answered 502 with an unexpected body`);
  });

  test("fails without calling anything when the job may not request an ID token", async () => {
    const { result } = await provision({ env: {} });
    expect(Result.isFailure(result) && result.failure).toContain("The job needs the `id-token: write` permission");
    expect(tokenRequests).toEqual([]);
    expect(actionCalls).toEqual([]);
  });

  test("never logs or reports a token", async () => {
    answers = [success({ status: "inProgress" }), success({ status: "refused", reason: "no" })];
    const { result, logs } = await provision({ advanceSeconds: 10 });
    const reported = [...logs, Result.isFailure(result) ? result.failure : ""].join("\n");
    expect(issued.length).toBeGreaterThan(0);
    for (const secret of [...issued, REQUEST_TOKEN]) expect(reported).not.toContain(secret);
  });
});
