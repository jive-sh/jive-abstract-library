import { Option } from "effect";
import { BASE_PACKAGE_DIR } from "../builder/interface";

/**
 * How long each platform package of a release took to download from its registry. The deploy hook logs
 * these lines and writes a job summary from them; `scripts/platform-download-times.ts` parses the logged
 * lines back out of every release run. Both sides live here so the format has one definition.
 */

/** Seconds from the moment every platform package of a release was published until one of them downloads. */
export interface PlatformDownloadTime {
  readonly platform: string;
  readonly seconds: number;
}

/** One release's download times, recovered from the log of the job that published it. */
export interface ReleaseDownloadTimes {
  readonly packageName: string;
  /** The base package's published version, e.g. `0.4.8`. */
  readonly version: string;
  readonly distTag: string;
  readonly downloads: ReadonlyArray<PlatformDownloadTime>;
}

export function publishingLine(packageName: string): string {
  return `Publishing ${packageName}`;
}

export function publishedBaseLine(input: { version: string; distTag: string }): string {
  return `  - ${BASE_PACKAGE_DIR}: ${input.version} (tag ${input.distTag})`;
}

export function platformDownloadedLine(input: PlatformDownloadTime & { tarballUrl: string }): string {
  return `  - ${input.platform} downloads after ${input.seconds}s: ${input.tarballUrl}`;
}

// npm package names contain no spaces, which keeps "Publishing base package" and "Publishing 5 platform
// packages in parallel" from matching.
const PUBLISHING = /^Publishing (\S+)$/;
const PUBLISHED_BASE = new RegExp(`^  - ${BASE_PACKAGE_DIR}: (\\S+) \\(tag (\\S+)\\)$`);
const PLATFORM_DOWNLOADED = /^ {2}- (\S+) downloads after (\d+)s: \S+$/;

/**
 * Reads the releases out of one deploy job's log messages (without any timestamp prefix), in order. A
 * release that logged no download time, because it had no platform packages or failed before any
 * downloaded, is left out.
 */
export function parseReleaseDownloadTimes(messages: ReadonlyArray<string>): ReadonlyArray<ReleaseDownloadTimes> {
  const releases: Array<ReleaseDownloadTimes & { downloads: PlatformDownloadTime[] }> = [];
  let maybePackageName = Option.none<string>();
  for (const message of messages) {
    const publishing = PUBLISHING.exec(message);
    if (publishing !== null) {
      maybePackageName = Option.some(publishing[1] as string);
      continue;
    }
    const base = PUBLISHED_BASE.exec(message);
    if (base !== null && Option.isSome(maybePackageName)) {
      releases.push({ packageName: maybePackageName.value, version: base[1] as string, distTag: base[2] as string, downloads: [] });
      maybePackageName = Option.none();
      continue;
    }
    const downloaded = PLATFORM_DOWNLOADED.exec(message);
    const current = releases[releases.length - 1];
    if (downloaded !== null && current !== undefined) {
      current.downloads.push({ platform: downloaded[1] as string, seconds: Number(downloaded[2]) });
    }
  }
  return releases.filter((release) => release.downloads.length > 0);
}

/**
 * The job summary of one release's wait: a table of each platform package's download time, and the ones
 * still not downloadable when the deploy gave up.
 */
export function downloadTimesSummary(input: {
  packageName: string;
  version: string;
  downloads: ReadonlyArray<PlatformDownloadTime>;
  notDownloadable: ReadonlyArray<string>;
  checkSeconds: number;
  timeoutSeconds: number;
}): string {
  const rows = [
    ...[...input.downloads].sort((a, b) => a.seconds - b.seconds).map((d) => `| ${d.platform} | ${d.seconds}s |`),
    ...input.notDownloadable.map((platform) => `| ${platform} | not downloadable after ${input.timeoutSeconds / 60} minutes |`),
  ];
  return [
    `### Platform package download times: ${input.packageName}@${input.version}`,
    "",
    `Seconds from publishing every platform package until each downloads from the registry`
    + ` (checked every ${input.checkSeconds} seconds, for up to ${input.timeoutSeconds / 60} minutes).`,
    "",
    "| Platform | Downloads after |",
    "| --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
