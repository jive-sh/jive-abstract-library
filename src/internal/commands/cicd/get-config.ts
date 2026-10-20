import { Schema } from "effect";
import { JivePackageConfig } from "../../public/manifest";
import { libraryModules } from "../../modules";
import { makeCicdCommand } from "../../common/command";

export const getConfig = makeCicdCommand(
  "get-config",
  "print this package's validated jive config as JSON for the pipeline's context job",
  function* () {
    const { jive } = yield* (yield* libraryModules.Package).load();
    process.stdout.write(`${JSON.stringify(Schema.encodeUnknownSync(JivePackageConfig)(jive))}\n`);
  },
);
