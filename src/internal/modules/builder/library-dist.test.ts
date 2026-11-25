import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * This library as its own build emits it (`bun run jive:cicd:build`, which CI runs before the tests): a consumer such as
 * @jive-sh/jive compiles its commands from the emitted JS in dist/base/dist, not from src. tsc emits only TypeScript, so
 * the builder copies the files postinstall-script.ts embeds as text next to the emitted JS; without them, a consumer's
 * build fails to resolve the imports, as jive-abstract-library 0.14.4's did.
 */

const root = join(import.meta.dir, "..", "..", "..", "..");
const emitted = join(root, "dist", "base", "dist");
const built = existsSync(emitted);
if (!built && process.env["CI"] !== undefined) throw new Error(`${emitted} is missing: CI runs the build before this test`);

const EMBEDDED = ["internal/common/postinstall.cjs", "internal/common/command-launcher.cjs"] as const;

test.skipIf(!built)("the emitted JS has the files postinstall-script.ts embeds, unchanged, and bundles them as their text", async () => {
  for (const file of EMBEDDED) {
    expect({ file, text: readFileSync(join(emitted, file), "utf8") }).toEqual({ file, text: readFileSync(join(root, "src", file), "utf8") });
  }

  // Bundled as a consumer's build bundles it, then run: each export must be its file's text.
  const outdir = mkdtempSync(join(tmpdir(), "library-dist-"));
  const bundled = await Bun.build({ entrypoints: [join(emitted, "internal", "common", "postinstall-script.js")], target: "bun", outdir });
  expect({ success: bundled.success, logs: bundled.logs }).toEqual({ success: true, logs: [] });
  const embedded = await import(bundled.outputs[0]!.path);
  expect({ postinstall: embedded.POSTINSTALL_SOURCE, launcher: embedded.COMMAND_LAUNCHER_SOURCE }).toEqual({
    postinstall: readFileSync(join(root, "src", EMBEDDED[0]), "utf8"),
    launcher: readFileSync(join(root, "src", EMBEDDED[1]), "utf8"),
  });
});
