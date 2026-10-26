import { Clock, Effect, Schema, SchemaIssue, pipe } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { implementing, type EffectGen } from "effective-modules";
import { libraryModules } from "../index";
import type { IJiveServer, ProvisionPackageInput } from "./interface";

/**
 * The audience every ID token shown to Jive is minted for. It names Jive's API, not where a deployment of it
 * is reached, so it stays the same whichever `serverUrl` a package configures; the server checks it.
 */
export const JIVE_API_AUDIENCE = "https://api.jive.sh";

/** The server's function, by its Convex path. */
const PROVISION_FUNCTION = "packages:provision";

const IN_PROGRESS_CHECK_SECONDS = 10;
const IN_PROGRESS_TIMEOUT_SECONDS = 600;

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
  Schema.Struct({ status: Schema.Literal("success"), value: ProvisionOutcome }),
  Schema.Struct({ status: Schema.Literal("error"), errorMessage: Schema.String }),
]);

const formatSchemaError = SchemaIssue.makeFormatterDefault();

export class JiveServerImpl extends implementing(libraryModules.JiveServer)
  .uses(libraryModules.PipelineIdentity, HttpClient.HttpClient)
  implements IJiveServer {
  *provisionPackage(input: ProvisionPackageInput): EffectGen<void, string> {
    const subject = `${input.registry} package ${input.packageName}`;
    yield* Effect.log(`Asking Jive at ${input.serverUrl} to provision the ${subject}`);
    const startedAt = yield* Clock.currentTimeMillis;
    while (true) {
      const outcome = yield* this.callProvision(input);
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

  /** One call of `packages.provision`, with an ID token taken for it alone. */
  private *callProvision(input: ProvisionPackageInput): EffectGen<ProvisionOutcome, string> {
    const operation = `call ${PROVISION_FUNCTION} at ${input.serverUrl}`;
    const idToken = yield* this.dependencies.PipelineIdentity.idToken(JIVE_API_AUDIENCE);
    const request = pipe(
      HttpClientRequest.post(`${input.serverUrl.replace(/\/+$/, "")}/api/action`),
      HttpClientRequest.bearerToken(idToken),
      HttpClientRequest.bodyJsonUnsafe({
        path: PROVISION_FUNCTION,
        args: { registry: input.registry, packageName: input.packageName },
        format: "json",
      }),
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
    if (decoded.status === "error") {
      return yield* Effect.fail(`Jive could not provision the ${input.registry} package ${input.packageName}, so nothing was published: ${decoded.errorMessage}`);
    }
    return decoded.value;
  }
}
