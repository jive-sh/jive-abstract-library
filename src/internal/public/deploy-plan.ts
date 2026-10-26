import { Schema } from "effect";

const HttpUrl = Schema.String.check(Schema.makeFilter(
  (url: string) => URL.canParse(url) && ["http:", "https:"].includes(new URL(url).protocol) && !/\s/.test(url)
    ? undefined
    : `"${url}" is not an absolute HTTP(S) URL`,
));

/**
 * What the `jive:cicd:deploy:plan` hook prints for one environment: whether this run has anything to
 * deploy there and, when it does, the URL the deployment will be reachable at. The pipeline drops an
 * environment with nothing to deploy, and skips the deploy job when none is left.
 *
 * Exported so every abstract prints the same shape the pipeline validates.
 */
export const DeployPlan = Schema.Union([
  Schema.Struct({ deploy: Schema.Literal(false) }),
  Schema.Struct({ deploy: Schema.Literal(true), url: HttpUrl }),
]);
export type DeployPlan = typeof DeployPlan.Type;
