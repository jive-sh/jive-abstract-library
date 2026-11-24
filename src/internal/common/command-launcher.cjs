#!/usr/bin/env node
"use strict";
/**
 * Every command's file in a built package's bin/, the same for every command: it is the command its own file name says.
 *
 * On macOS and Linux it runs once. It has the package's postinstall.cjs replace it (and every other command's file)
 * with a hard link to the real program, which the package manager skips when it does not run postinstall (Bun, for a
 * package it does not trust), then runs the program with what was typed. On Windows a command starts through its .cmd
 * shim, which always runs this file, so it runs the program every time and sets up again only when the commands are
 * stale.
 *
 * CommonJS for the reason postinstall.cjs gives: bin/package.json makes this extensionless file CommonJS.
 */
const { spawnSync } = require("child_process");
const { realpathSync } = require("fs");
const { basename, dirname, join } = require("path");

// The real path: reached through a link in a bin directory, the package is wherever the link points.
const launcherPath = realpathSync(__filename);
const packageDir = dirname(dirname(launcherPath));
const postinstall = require(join(packageDir, "postinstall.cjs"));

if (process.platform !== "win32" || !postinstall.commandsAreCurrent({ packageDir })) {
  // A shell's, a launcher's or the user's own call to the completion code is left to do its job alone.
  const setUpCompletion = !postinstall.COMPLETION_FLAGS.includes(process.argv[2]);
  postinstall.setUp({ packageDir, repairOnly: false, setUpCompletion });
}

const result = spawnSync(postinstall.commandTarget({ packageDir, command: basename(launcherPath) }), process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
