import { Schema } from "effect";
import commandLauncherText from "./command-launcher.cjs" with { type: "text" };
import postinstallText from "./postinstall.cjs" with { type: "text" };

/**
 * The two files the builder copies unchanged into every package with commands or daemons: postinstall.cjs at its root
 * and command-launcher.cjs as each command in bin/. Embedded as text because the published CLI is a Bun-compiled
 * binary with no source files on disk to read; this library only ships them and never runs them.
 */

const asText = Schema.decodeUnknownSync(Schema.String);

export const COMMAND_LAUNCHER_SOURCE: string = asText(commandLauncherText);
export const POSTINSTALL_SOURCE: string = asText(postinstallText);
