import { Effect, Option, Schema, pipe } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules } from "../index";
import type { IPipelineIdentity } from "./interface";

/**
 * GitHub Actions gives a job permitted `id-token: write` these two variables, and answers a GET of the URL,
 * with the audience appended and the request token as a bearer, with `{ value: <ID token> }`
 * (https://docs.github.com/en/actions/reference/security/oidc#methods-for-requesting-the-oidc-token).
 */
const REQUEST_URL_VARIABLE = "ACTIONS_ID_TOKEN_REQUEST_URL";
const REQUEST_TOKEN_VARIABLE = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

const IdTokenResponse = Schema.Struct({ value: Schema.NonEmptyString });

export class PipelineIdentityImpl extends implementing(libraryModules.PipelineIdentity)
  .uses(libraryModules.OSPlatform, HttpClient.HttpClient)
  implements IPipelineIdentity {
  *idToken(audience: string): EffectGen<string, string> {
    const osPlatform = this.dependencies.OSPlatform;
    const maybeRequestUrl = yield* osPlatform.readEnv(REQUEST_URL_VARIABLE);
    const maybeRequestToken = yield* osPlatform.readEnv(REQUEST_TOKEN_VARIABLE);
    if (Option.isNone(maybeRequestUrl) || Option.isNone(maybeRequestToken)) {
      return yield* Effect.fail(
        `Cannot get a GitHub Actions ID token: ${REQUEST_URL_VARIABLE} and ${REQUEST_TOKEN_VARIABLE} are not set.`
        + " The job needs the `id-token: write` permission, which Jive's reusable pipeline grants its deploy job.",
      );
    }

    const operation = `request a GitHub Actions ID token for ${audience}`;
    const response = yield* pipe(
      this.getDependency(HttpClient.HttpClient).execute(pipe(
        HttpClientRequest.get(`${maybeRequestUrl.value}&audience=${encodeURIComponent(audience)}`),
        HttpClientRequest.bearerToken(maybeRequestToken.value),
      )),
      Effect.mapError((e) => `Cannot ${operation}: ${e.message}`),
    );
    if (response.status !== 200) {
      return yield* Effect.fail(`Cannot ${operation}: GitHub answered ${response.status}`);
    }
    const { value } = yield* pipe(
      response.json,
      Effect.flatMap(Schema.decodeUnknownEffect(IdTokenResponse)),
      Effect.mapError(() => `Cannot ${operation}: GitHub's answer has no token`),
    );
    return value;
  }
}
