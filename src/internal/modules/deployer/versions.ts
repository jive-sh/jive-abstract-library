import { LATEST_ENVIRONMENT, LOCAL_ENVIRONMENT, PREVIEW_ENVIRONMENT, isEnvironment } from "../../public/manifest";

/**
 * Versions a build once per environment. The build always stamps `local`, so a release recomputes
 * every version from the base version alone rather than editing the strings it finds.
 */

export const PREVIEW_SHA_LENGTH = 8;

/** The `X.Y.Z` a build's folders were stamped from, recovered from the base package's local version. */
export function baseVersionOf(localVersion: string): string | undefined {
  const suffix = `-${LOCAL_ENVIRONMENT}`;
  return localVersion.endsWith(suffix) ? localVersion.slice(0, -suffix.length) : undefined;
}

/**
 * The prerelease identifier every package in a release shares. `latest` is the one environment with
 * none on the base package; `preview` pins to the commit so each run publishes a distinct version.
 */
function releaseTag(environment: string, sourceCommitSha: string): string | undefined {
  if (isEnvironment(environment, LATEST_ENVIRONMENT)) return undefined;
  if (isEnvironment(environment, PREVIEW_ENVIRONMENT)) {
    return `${PREVIEW_ENVIRONMENT}-${sourceCommitSha.slice(0, PREVIEW_SHA_LENGTH)}`;
  }
  return environment;
}

export function baseVersion(baseVersion: string, environment: string, sourceCommitSha: string): string {
  const tag = releaseTag(environment, sourceCommitSha);
  return tag === undefined ? baseVersion : `${baseVersion}-${tag}`;
}

export function platformVersion(
  version: string,
  environment: string,
  sourceCommitSha: string,
  platform: string,
): string {
  const tag = releaseTag(environment, sourceCommitSha) ?? LATEST_ENVIRONMENT;
  return `${version}-${tag}-${platform}`;
}

/** npm dist-tag a package is published under, which always mirrors its own prerelease. */
export function baseDistTag(environment: string, sourceCommitSha: string): string {
  return releaseTag(environment, sourceCommitSha) ?? LATEST_ENVIRONMENT;
}

export function platformDistTag(environment: string, sourceCommitSha: string, platform: string): string {
  return `${baseDistTag(environment, sourceCommitSha)}-${platform}`;
}
