/**
 * Prints, as markdown, how long every platform package took to download after its release published it,
 * for every release run of every repository that builds with jive-abstract-library: one row per release,
 * then each platform's spread. The times come from each run's own log (`gh run view --log`), so nothing
 * stores them; runs whose logs GitHub no longer keeps drop out. Needs `gh` signed in.
 *
 *   bun run platform-download-times > times.md
 */
import { Console, Effect, Logger, Option, Result, Schema, pipe } from "effect";
import { effunct, type EffectGen } from "effective-modules";
import { stderrLogger } from "../src/internal/common/logger";
import { libraryModules, type LibraryModules } from "../src/internal/modules";
import { OSPlatformImpl } from "../src/internal/modules/os-platform/impl";
import { parseReleaseDownloadTimes, type ReleaseDownloadTimes } from "../src/internal/modules/deployer/download-times";
import libraryManifest from "../package.json";

const LOG_FETCH_CONCURRENCY = 8;
/** The step of jive-sh/jive's reusable pipeline that runs the `jive:cicd:deploy` hook. */
const DEPLOY_STEP_NAME = "Deploy";

interface ReleaseRun {
  readonly repository: string;
  readonly runUrl: string;
  readonly createdAt: string;
  readonly release: ReleaseDownloadTimes;
}

const Owner = Schema.Struct({ login: Schema.String });
const Repository = Schema.Struct({ nameWithOwner: Schema.String });
const Run = Schema.Struct({ databaseId: Schema.Number, createdAt: Schema.String, status: Schema.String, url: Schema.String });
const Jobs = Schema.Struct({
  jobs: Schema.Array(Schema.Struct({
    databaseId: Schema.Number,
    name: Schema.String,
    steps: Schema.Array(Schema.Struct({ name: Schema.String, conclusion: Schema.String })),
  })),
});
const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String));
const Manifest = Schema.Struct({ name: Schema.optionalKey(Schema.String), dependencies: Dependencies, devDependencies: Dependencies });

function* gh(args: ReadonlyArray<string>): EffectGen<Result.Result<string, string>, string, LibraryModules.OSPlatform> {
  const { exitCode, stdout, stderr } = yield* (yield* libraryModules.OSPlatform).spawnProcess({ command: "gh", args });
  return exitCode === 0 ? Result.succeed(stdout) : Result.fail(`gh ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
}

function* ghJson<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, args: ReadonlyArray<string>): EffectGen<S["Type"], string, LibraryModules.OSPlatform> {
  const output = yield* gh(args);
  if (Result.isFailure(output)) return yield* Effect.fail(output.failure);
  return yield* pipe(
    Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(output.success),
    Effect.mapError((e) => `gh ${args.join(" ")} printed unexpected JSON: ${e.message}`),
  );
}

/** The signed-in user and every organization they belong to. */
function* owners(): EffectGen<ReadonlyArray<string>, string, LibraryModules.OSPlatform> {
  const user = yield* ghJson(Owner, ["api", "user"]);
  const orgs = yield* ghJson(Schema.Array(Owner), ["api", "user/orgs"]);
  return [user.login, ...orgs.map((org) => org.login)];
}

/** Whether the repository is jive-abstract-library itself or its root package.json depends on it. */
function* buildsWithLibrary(repository: string): EffectGen<boolean, string, LibraryModules.OSPlatform> {
  const output = yield* gh(["api", `repos/${repository}/contents/package.json`, "-H", "Accept: application/vnd.github.raw+json"]);
  if (Result.isFailure(output)) return false;
  const decoded = yield* Effect.result(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(output.success));
  if (Result.isFailure(decoded)) return false;
  const manifest = decoded.success;
  return manifest.name === libraryManifest.name
    || manifest.dependencies?.[libraryManifest.name] !== undefined
    || manifest.devDependencies?.[libraryManifest.name] !== undefined;
}

/**
 * Every release recorded in one run. Only the logs of jobs whose deploy step ran are downloaded: GitHub
 * meters log downloads, and reading every job of every run hit its "Egress is over the account limit".
 */
function* releasesInRun(repository: string, run: typeof Run.Type): EffectGen<ReadonlyArray<ReleaseRun>, string, LibraryModules.OSPlatform> {
  const { jobs } = yield* ghJson(Jobs, ["run", "view", String(run.databaseId), "-R", repository, "--json", "jobs"]);
  const deployJobs = jobs.filter((job) => job.steps.some((step) => step.name === DEPLOY_STEP_NAME && step.conclusion !== "skipped"));
  const releases: ReleaseRun[] = [];
  for (const job of deployJobs) {
    const output = yield* gh(["run", "view", String(run.databaseId), "-R", repository, "--log", "--job", String(job.databaseId)]);
    if (Result.isFailure(output)) {
      yield* Effect.logWarning(`Skipping ${job.name} of ${run.url}: ${output.failure}`);
      continue;
    }
    // Each line is `<job>\t<step>\t<timestamp> <message>`.
    const messages = output.success.split("\n").flatMap((line) => {
      const stamped = line.replace(/\r$/, "").split("\t")[2];
      return stamped === undefined ? [] : [stamped.slice(stamped.indexOf(" ") + 1)];
    });
    releases.push(...parseReleaseDownloadTimes(messages).map((release) => ({ repository, runUrl: run.url, createdAt: run.createdAt, release })));
  }
  return releases;
}

function median(sorted: ReadonlyArray<number>): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function markdown(runs: ReadonlyArray<ReleaseRun>): string {
  const platforms = [...new Set(runs.flatMap((run) => run.release.downloads.map((d) => d.platform)))].sort();
  const secondsOf = (run: ReleaseRun, platform: string) =>
    Option.fromUndefinedOr(run.release.downloads.find((d) => d.platform === platform)?.seconds);
  const releaseRows = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((run) => [
    run.createdAt.slice(0, 16).replace("T", " "),
    run.repository,
    `[${run.release.packageName}@${run.release.version}](${run.runUrl})`,
    ...platforms.map((platform) => Option.match(secondsOf(run, platform), { onNone: () => "", onSome: (s) => `${s}s` })),
  ]);
  const spreadRows = platforms.map((platform) => {
    const times = runs.flatMap((run) => Option.toArray(secondsOf(run, platform))).sort((a, b) => a - b);
    return [platform, String(times.length), `${times[0]}s`, `${median(times)}s`, `${times[times.length - 1]}s`, times.join(", ")];
  });
  const table = (header: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>) =>
    [header, header.map(() => "---"), ...rows].map((cells) => `| ${cells.join(" | ")} |`).join("\n");
  return [
    "## Platform package download times",
    "",
    "Seconds from publishing every platform package of a release until each downloads from its registry, read from each release run's log.",
    "",
    table(["Run started (UTC)", "Repository", "Release", ...platforms], releaseRows),
    "",
    "## Spread per platform",
    "",
    table(["Platform", "Releases", "Fastest", "Median", "Slowest", "Every time, in seconds"], spreadRows),
    "",
  ].join("\n");
}

function* program(): EffectGen<void, string, LibraryModules.OSPlatform> {
  const repositories: string[] = [];
  for (const owner of yield* owners()) {
    const listed = yield* ghJson(Schema.Array(Repository), ["repo", "list", owner, "--no-archived", "--limit", "1000", "--json", "nameWithOwner"]);
    for (const { nameWithOwner } of listed) {
      if (yield* buildsWithLibrary(nameWithOwner)) repositories.push(nameWithOwner);
    }
  }
  yield* Effect.log(`Repositories that build with ${libraryManifest.name}: ${repositories.join(", ")}`);

  const runs: Array<{ repository: string; run: typeof Run.Type }> = [];
  for (const repository of repositories) {
    const listed = yield* ghJson(Schema.Array(Run), ["run", "list", "-R", repository, "--event", "push", "--limit", "1000", "--json", "databaseId,createdAt,status,url"]);
    runs.push(...listed.filter((run) => run.status === "completed").map((run) => ({ repository, run })));
  }
  yield* Effect.log(`Reading the logs of ${runs.length} completed push runs, ${LOG_FETCH_CONCURRENCY} at a time`);

  const releases = (yield* Effect.forEach(
    runs,
    ({ repository, run }) => effunct(releasesInRun)(repository, run),
    { concurrency: LOG_FETCH_CONCURRENCY },
  )).flat();
  yield* Effect.log(`Found ${releases.length} releases with download times`);
  yield* Console.log(markdown(releases));
}

const result = await Effect.runPromise(pipe(
  effunct(program)(),
  Effect.provide(OSPlatformImpl.Layer),
  Effect.provide(Logger.layer([stderrLogger])),
  Effect.result,
));
if (Result.isFailure(result)) {
  process.stderr.write(`✗ ${result.failure}\n`);
  process.exit(1);
}
