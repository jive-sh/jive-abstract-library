import { program } from "commander";
import { cicd } from "../internal/commands/cicd";
import { dev } from "../internal/commands/dev";
import { CLI_CMD_NAME } from "../internal/common/constants";

program.name(CLI_CMD_NAME).description("build and publish a package that extends jive-abstract-library");
program.addCommand(cicd);
program.addCommand(dev);
program.parse();

if (process.argv.length <= 2) program.help();
