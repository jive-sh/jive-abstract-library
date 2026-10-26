import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Result, pipe } from "effect";
import { FetchHttpClient } from "effect/http";
import { effunct } from "effective-modules";
import { libraryModules } from "../index";
import { OSPlatformImpl } from "../os-platform/impl";
import { PipelineIdentityImpl } from "./impl";

/** A fake GitHub token endpoint answering every request with `status` and `body`. */
let answer: { status: number; body: string } = { status: 200, body: "{}" };
const github = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(answer.body, { status: answer.status }) });
afterAll(() => github.stop(true));

async function idToken(env: Record<string, string>) {
  const osPlatform = OSPlatformImpl.mockLayer({ *readEnv(name: string) { return Option.fromUndefinedOr(env[name]); } });
  return Effect.runPromise(pipe(
    Effect.result(effunct(function* () {
      return yield* (yield* libraryModules.PipelineIdentity).idToken("https://api.jive.sh");
    })()),
    Effect.provide(pipe(PipelineIdentityImpl.Layer, Layer.provideMerge(osPlatform), Layer.provideMerge(FetchHttpClient.layer))),
  ));
}

const env: Record<string, string> = {
  ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${github.port}/token?api-version=2.0`,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

describe("idToken", () => {
  test("returns the token GitHub answers with", async () => {
    answer = { status: 200, body: JSON.stringify({ count: 1, value: "the-id-token" }) };
    expect(await idToken(env)).toEqual(Result.succeed("the-id-token"));
  });

  test("fails without repeating GitHub's body when GitHub refuses or answers without a token", async () => {
    answer = { status: 403, body: "secret-looking body" };
    const refused = await idToken(env);
    expect(Result.isFailure(refused) && refused.failure).toBe("Cannot request a GitHub Actions ID token for https://api.jive.sh: GitHub answered 403");
    answer = { status: 200, body: JSON.stringify({ value: "" }) };
    const empty = await idToken(env);
    expect(Result.isFailure(empty) && empty.failure).toBe("Cannot request a GitHub Actions ID token for https://api.jive.sh: GitHub's answer has no token");
  });

  test("says the job needs id-token: write when either variable is missing", async () => {
    const partials: Array<Record<string, string>> = [{}, { ACTIONS_ID_TOKEN_REQUEST_URL: env["ACTIONS_ID_TOKEN_REQUEST_URL"]! }];
    for (const partial of partials) {
      const result = await idToken(partial);
      expect(Result.isFailure(result) && result.failure).toContain("The job needs the `id-token: write` permission");
    }
  });
});
