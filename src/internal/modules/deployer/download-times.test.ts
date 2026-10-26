import { describe, expect, test } from "bun:test";
import { parseReleaseDownloadTimes } from "./download-times";

describe("reading download times back from a deploy job's log", () => {
  test("reads skill-sync 0.4.8's release, ignoring the other lines that start with Publishing or name the base", () => {
    // Messages from https://github.com/jive-sh/skill-sync/actions/runs/40247421100, timestamps removed.
    const messages = [
      "  - base: 0.4.8-local",
      "Publishing @jive-sh/skill-sync",
      "Commit 3851a86e, built from version 0.4.8 in dist",
      "  - base: 0.4.8 (tag latest)",
      "Publishing 5 platform packages in parallel",
      "npm notice Publishing to https://registry.npmjs.org/ with tag latest-darwin-arm64 and public access",
      "  - darwin-arm64 downloads after 116s: https://registry.npmjs.org/@jive-sh/skill-sync/-/skill-sync-0.4.8-latest-darwin-arm64.tgz",
      "  Still waiting after 138s for linux-x64 (@jive-sh/skill-sync@0.4.8-latest-linux-x64): the registry does not list it yet",
      "  - linux-x64 downloads after 427s: https://registry.npmjs.org/@jive-sh/skill-sync/-/skill-sync-0.4.8-latest-linux-x64.tgz",
      "Publishing base package",
    ];
    expect(parseReleaseDownloadTimes(messages)).toEqual([{
      packageName: "@jive-sh/skill-sync",
      version: "0.4.8",
      distTag: "latest",
      downloads: [{ platform: "darwin-arm64", seconds: 116 }, { platform: "linux-x64", seconds: 427 }],
    }]);
  });

  test("leaves out a release that logged no download time", () => {
    expect(parseReleaseDownloadTimes(["Publishing demo", "  - base: 1.0.0 (tag latest)", "Publishing base package"])).toEqual([]);
  });
});
