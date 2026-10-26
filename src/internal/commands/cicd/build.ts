import { Effect, Option } from "effect";
import { LOCAL_ENVIRONMENT } from "../../public/manifest";
import { libraryModules } from "../../modules";
import { makeCicdCommand } from "../../common/command";

export const build = makeCicdCommand(
  "build",
  "build the package folders under dist/ and install the result locally",
  function* () {
    yield* (yield* libraryModules.Builder).build({ localOnly: false });
    // Installing here means a later audit sees the package exactly as a consumer machine would.
    yield* (yield* libraryModules.Deployer).deploy({
      environment: LOCAL_ENVIRONMENT,
      sourceCommitSha: "",
      maybeJobSummaryPath: Option.none(),
      provisionWithJive: Option.none(),
    });
    yield* Effect.log("Build complete");
  },
);
