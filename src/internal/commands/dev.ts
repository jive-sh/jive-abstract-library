import { Command } from "commander";
import { genPackageJsonSchema, runDevServer } from "../public/dev-server";

/**
 * `jive-library dev`. A subcommand rather than its own entrypoint file: every entrypoint a package has
 * compiles into the same multi-call binary, so a separate one would add a second command name and a second
 * bin shim without sharing any less code.
 */
export const dev = new Command("dev")
  .description("watch this package and keep its generated package.schema.json current while you work")
  .action(() => runDevServer({ genPackageJsonSchema }));
