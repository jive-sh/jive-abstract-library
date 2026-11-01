import { Clock, Effect, Option, Schema, SchemaIssue, pipe } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules } from "../index";
import type { IJiveServer, ProvisionPackageInput } from "./interface";

/**
 * The audience every ID token shown to Jive is minted for. It names Jive's API, not where a deployment of it
 * is reached, so it stays the same whichever `serverUrl` a package configures; the server checks it.
 */
export const JIVE_API_AUDIENCE = "https://api.jive.sh";

/** The server's functions, by their Convex paths. */
const SIGN_IN_FUNCTION = "pipelineSessions:signIn";
const PROVISION_FUNCTION = "packages:provision";

const IN_PROGRESS_CHECK_SECONDS = 10;
const IN_PROGRESS_TIMEOUT_SECONDS = 600;

/** What `pipelineSessions.signIn` answers: a session token for this job's pipeline, or why not. */
const SignInOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signedIn"), sessionToken: Schema.String, expiresAt: Schema.Number }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: Schema.String }),
]);

/** What `packages.provision` answers. */
const ProvisionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready") }),
  Schema.Struct({ status: Schema.Literal("inProgress") }),
  Schema.Struct({ status: Schema.Literal("refused"), reason: Schema.String }),
]);
type ProvisionOutcome = Schema.Schema.Type<typeof ProvisionOutcome>;

/**
 * Convex's HTTP API answer to `POST /api/action` (https://docs.convex.dev/http-api/): the function's value, or
 * the error it failed with.
 */
const ActionResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("success"), value: Schema.Unknown }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class JiveServerImpl extends implementing(libraryModules.JiveServer)
  .uses(libraryModules.PipelineIdentity, HttpClient.HttpClient)
  implements IJiveServer {
  *provisionPackage(input: ProvisionPackageInput): EffectGen<void, string> {
    const subject = `${input.registry} package ${input.packageName}`;
    yield* Effect.log(`Asking Jive at ${input.serverUrl} to provision the ${subject}`);
    const sessionToken = yield* this.signIn(input);
    const startedAt = yield* Clock.currentTimeMillis;
    while (true) {
      const outcome = yield* this.callAction({
        serverUrl: input.serverUrl,
        path: PROVISION_FUNCTION,
        args: { sessionToken, registry: input.registry, packageName: input.packageName },
        bearer: Option.none(),
        value: ProvisionOutcome,
        failed: `Jive could not provision the ${subject}, so nothing was published`,
      });
      if (outcome.status === "ready") {
        yield* Effect.log(`Jive provisioned the ${subject}; it is ready to publish`);
        return;
      }
      if (outcome.status === "refused") {
        return yield* Effect.fail(`Jive refused to provision the ${subject}, so nothing was published: ${outcome.reason}`);
      }
      const waitedSeconds = Math.round((Number(yield* Clock.currentTimeMillis) - Number(startedAt)) / 1000);
      if (waitedSeconds + IN_PROGRESS_CHECK_SECONDS > IN_PROGRESS_TIMEOUT_SECONDS) {
        return yield* Effect.fail(
          `After ${IN_PROGRESS_TIMEOUT_SECONDS / 60} minutes another deploy is still provisioning the ${subject}, so nothing was published`,
        );
      }
      yield* Effect.log(`  Another deploy is provisioning the ${subject} (after ${waitedSeconds}s); asking again in ${IN_PROGRESS_CHECK_SECONDS} seconds`);
      yield* Effect.sleep(`${IN_PROGRESS_CHECK_SECONDS} seconds`);
    }
  }

  /**
   * Exchanges an ID token GitHub mints for Jive's audience for a session of this job's pipeline, which every later
   * call takes. The session outlives the 10 minutes provisioning may wait, so one sign-in serves every call.
   */
  private *signIn(input: ProvisionPackageInput): EffectGen<string, string> {
    const idToken = yield* this.dependencies.PipelineIdentity.idToken(JIVE_API_AUDIENCE);
    const outcome = yield* this.callAction({
      serverUrl: input.serverUrl,
      path: SIGN_IN_FUNCTION,
      args: {},
      bearer: Option.some(idToken),
      value: SignInOutcome,
      failed: "Jive could not sign this deploy job in, so nothing was published",
    });
    if (outcome.status === "refused") {
      return yield* Effect.fail(`Jive refused to sign this deploy job in, so nothing was published: ${outcome.reason}`);
    }
    return outcome.sessionToken;
  }

  /**
   * One Convex action over the HTTP API, with `bearer` as the Authorization token when given. A function error fails
   * with `failed` and Convex's message; an answer that is not Convex's fails quoting it.
   */
  private *callAction<S extends Schema.Top & { readonly DecodingServices: never }>(input: {
    readonly serverUrl: string;
    readonly path: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly bearer: Option.Option<string>;
    readonly value: S;
    readonly failed: string;
  }): EffectGen<S["Type"], string> {
    const operation = `call ${input.path} at ${input.serverUrl}`;
    const request = pipe(
      HttpClientRequest.post(`${input.serverUrl.replace(/\/+$/, "")}/api/action`),
      (built) => Option.isSome(input.bearer) ? HttpClientRequest.bearerToken(built, input.bearer.value) : built,
      HttpClientRequest.bodyJsonUnsafe({ path: input.path, args: input.args, format: "json" }),
    );
    const response = yield* pipe(
      this.getDependency(HttpClient.HttpClient).execute(request),
      Effect.mapError((e) => `Cannot ${operation}: ${e.message}`),
    );
    const text = yield* pipe(response.text, Effect.mapError((e) => `Cannot ${operation}: ${e.message}`));
    const decoded = yield* pipe(
      Schema.decodeUnknownEffect(Schema.fromJsonString(ActionResponse))(text),
      Effect.mapError((e) => `Cannot ${operation}: it answered ${response.status} with an unexpected body (${formatSchemaError(e.issue)}): ${text.slice(0, 500)}`),
    );
    if (decoded.status === "error") return yield* Effect.fail(`${input.failed}: ${decoded.errorMessage}`);
    return yield* pipe(
      Schema.decodeUnknownEffect(input.value)(decoded.value),
      // Not quoting the value: a sign-in's holds the session token.
      Effect.mapError(() => `Cannot ${operation}: it answered a value this version of jive-abstract-library does not read; the server may be newer`),
    );
  }
}
