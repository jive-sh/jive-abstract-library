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
 * answers `pipelineSessions:signIn` with a session token (or `signInAnswer`) and `packages:provision` with whatever
 * each test queues.
 */

const REQUEST_TOKEN = "github-request-token";
const PACKAGE = "@test/demo";
const SESSION_TOKEN = "jive_pipeline-session-1";

let issued: string[] = [];
let tokenRequests: Array<{ audience: string | null; authorization: string | null; apiVersion: string | null }> = [];
let actionCalls: Array<{ authorization: string | null; body: any }> = [];
/** Answers of `packages:provision`, in order; the last repeats. */
let answers: Array<{ status: number; body: string }> = [];
/** The answer of `pipelineSessions:signIn`. */
let signInAnswer: { status: number; body: string };

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
      const body = await request.json() as { path: string };
      actionCalls.push({ authorization: request.headers.get("authorization"), body });
      const provisionCalls = actionCalls.filter((call) => call.body.path === "packages:provision").length;
      const answer = body.path === "pipelineSessions:signIn" ? signInAnswer : answers[Math.min(provisionCalls, answers.length) - 1]!;
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
  signInAnswer = success({ status: "signedIn", sessionToken: SESSION_TOKEN, expiresAt: 1_800_000_000_000 });
});

const githubEnv: Record<string, string> = {
  ACTIONS_ID_TOKEN_REQUEST_URL: `${SERVER_URL}/token?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
};

/** Resolves once `condition` holds, checking every 2 ms of real time; rejects after 5 seconds. */
async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the provision call");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  // The sleep starts in the same fiber run as the log line before it; let that run finish.
  await new Promise((resolve) => setTimeout(resolve, 2));
}

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
      let finished = false;
      const fiber = yield* Effect.forkChild(pipe(
        Effect.result(effunct(function* () {
          yield* (yield* libraryModules.JiveServer).provisionPackage({ serverUrl: SERVER_URL, registry: "npm", packageName: PACKAGE });
        })()),
        Effect.ensuring(Effect.sync(() => { finished = true; })),
      ));
      // The clock moves only once the call is asleep (it logs "asking again" just before sleeping) or over:
      // moving it while a real request is in flight would start the next sleep from the moved time and skip a poll.
      const asleepTimes = () => logs.filter((line) => line.includes("asking again")).length;
      for (let step = 0; step * 10 < (input.advanceSeconds ?? 0); step++) {
        yield* Effect.promise(() => waitUntil(() => finished || asleepTimes() > step));
        if (finished) break;
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

/** The calls of one function, by its Convex path. */
const callsOf = (path: string) => actionCalls.filter((call) => call.body.path === path);

const provisionCall = { authorization: null, body: { path: "packages:provision", args: { sessionToken: SESSION_TOKEN, registry: "npm", packageName: PACKAGE }, format: "json" } };

describe("provisionPackage", () => {
  test("signs the job in with a token GitHub minted for Jive's audience, then calls packages:provision with the session, and succeeds when ready", async () => {
    answers = [success({ status: "ready" })];
    const { result, logs } = await provision();
    expect(Result.isSuccess(result)).toBe(true);
    expect(tokenRequests).toEqual([{ audience: JIVE_API_AUDIENCE, authorization: `Bearer ${REQUEST_TOKEN}`, apiVersion: "2.0" }]);
    expect(actionCalls).toEqual([
      { authorization: "Bearer id-token-1", body: { path: "pipelineSessions:signIn", args: {}, format: "json" } },
      provisionCall,
    ]);
    expect(logs).toEqual([
      `Asking Jive at ${SERVER_URL} to provision the npm package ${PACKAGE}`,
      `Jive provisioned the npm package ${PACKAGE}; it is ready to publish`,
    ]);
  });

  test("while another deploy holds the package, asks again every 10 seconds with the same session", async () => {
    answers = [success({ status: "inProgress" }), success({ status: "inProgress" }), success({ status: "ready" })];
    const { result, logs } = await provision({ advanceSeconds: 30 });
    expect(Result.isSuccess(result)).toBe(true);
    expect(callsOf("pipelineSessions:signIn")).toHaveLength(1);
    expect(callsOf("packages:provision")).toEqual([provisionCall, provisionCall, provisionCall]);
    expect(logs).toContain(`  Another deploy is provisioning the npm package ${PACKAGE} (after 10s); asking again in 10 seconds`);
  });

  test("gives up after 10 minutes of another deploy holding the package", async () => {
    answers = [success({ status: "inProgress" })];
    const { result } = await provision({ advanceSeconds: 700 });
    expect(Result.isFailure(result) && result.failure).toBe(
      `After 10 minutes another deploy is still provisioning the npm package ${PACKAGE}, so nothing was published`,
    );
    // Asked at 0, 10, …, 600 seconds.
    expect(callsOf("packages:provision")).toHaveLength(61);
  });

  test("fails with Jive's reason when it refuses to sign the job in, without asking to provision", async () => {
    signInAnswer = success({ status: "refused", reason: "jive-sh/demo (id 1) is not a code repository registered with Jive" });
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toBe(
      "Jive refused to sign this deploy job in, so nothing was published: jive-sh/demo (id 1) is not a code repository registered with Jive",
    );
    expect(callsOf("packages:provision")).toEqual([]);
  });

  test("fails with Jive's reason when it refuses to provision", async () => {
    answers = [success({ status: "refused", reason: "@test/demo is provisioned for another code repository" })];
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toBe(
      `Jive refused to provision the npm package ${PACKAGE}, so nothing was published: @test/demo is provisioned for another code repository`,
    );
  });

  test("fails with Convex's error when a function fails", async () => {
    signInAnswer = { status: 500, body: JSON.stringify({ status: "error", errorMessage: "Uncaught Error: Not authenticated", logLines: [] }) };
    expect((await provision()).result).toEqual(Result.fail("Jive could not sign this deploy job in, so nothing was published: Uncaught Error: Not authenticated"));

    signInAnswer = success({ status: "signedIn", sessionToken: SESSION_TOKEN, expiresAt: 1_800_000_000_000 });
    answers = [{ status: 500, body: JSON.stringify({ status: "error", errorMessage: "Uncaught Error: Server Error", logLines: [] }) }];
    expect((await provision()).result).toEqual(Result.fail(`Jive could not provision the npm package ${PACKAGE}, so nothing was published: Uncaught Error: Server Error`));
  });

  test("fails, naming the answer, when the server's answer is not Convex's", async () => {
    signInAnswer = { status: 502, body: "Bad Gateway" };
    const { result } = await provision();
    expect(Result.isFailure(result) && result.failure).toContain(`Cannot call pipelineSessions:signIn at ${SERVER_URL}: it answered 502 with an unexpected body`);
  });

  test("fails without quoting it when a function's value is not what this version reads", async () => {
    signInAnswer = success({ status: "signedIn", sessionToken: SESSION_TOKEN, expiresAt: "later" });
    const { result } = await provision();
    expect(result).toEqual(Result.fail(`Cannot call pipelineSessions:signIn at ${SERVER_URL}: it answered a value this version of jive-abstract-library does not read; the server may be newer`));
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
    for (const secret of [...issued, REQUEST_TOKEN, SESSION_TOKEN]) expect(reported).not.toContain(secret);
  });
});
