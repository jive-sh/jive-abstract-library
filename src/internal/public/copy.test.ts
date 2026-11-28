import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem, Result } from "effect";
import { listCopyableEntries, listCopyablePaths, resolveCopyEntries } from "./copy";

/** A package root holding every kind of path the listing has to tell apart. */
function makePackage(): string {
  const root = mkdtempSync(join(tmpdir(), "jive-copy-"));
  for (const file of [
    "README.md",
    "LICENSE",
    "tsconfig.json",
    "package.json",
    "package.schema.json",
    "postinstall.cjs",
    "docs/guide.md",
    "docs/images/logo.svg",
    "src/index.ts",
    "dist/base/package.json",
    "bin/tool",
    "node_modules/effect/package.json",
    ".git/HEAD",
    "test/fixture/node_modules/left-pad/index.js",
    "test/fixture/package.json",
    "template/README.md",
  ]) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  // A link back up the tree must not make the listing loop.
  symlinkSync(join(root, "docs"), join(root, "docs", "images", "up"));
  return root;
}

const run = <A>(effect: Effect.Effect<A, string, FileSystem.FileSystem>) => Effect.runPromise(Effect.provide(effect, BunFileSystem.layer));
const runResult = <A>(effect: Effect.Effect<A, string, FileSystem.FileSystem>) => Effect.runPromise(Effect.provide(Effect.result(effect), BunFileSystem.layer));

describe("the paths copy may name", () => {
  test("are every file and folder the build neither generates nor manages, sorted, reserved folders never entered", async () => {
    const rootDir = makePackage();
    expect(await run(listCopyablePaths({ rootDir, extraReservedPaths: [] }))).toEqual([
      "docs",
      "docs/guide.md",
      "docs/images",
      "docs/images/logo.svg",
      "docs/images/up",
      "LICENSE",
      "README.md",
      "template",
      "template/README.md",
      "test",
      "test/fixture",
      "test/fixture/package.json",
      "tsconfig.json",
    ]);
  });

  test("leave out what an extending abstract's build writes", async () => {
    const rootDir = makePackage();
    const paths = await run(listCopyablePaths({ rootDir, extraReservedPaths: ["template"] }));
    expect(paths.filter((path) => path.startsWith("template"))).toEqual([]);
  });

  test("say whether each is a file or a folder", async () => {
    const rootDir = makePackage();
    const entries = await run(listCopyableEntries({ rootDir, extraReservedPaths: [] }));
    expect(entries.filter((entry) => ["docs", "README.md"].includes(entry.path))).toEqual([
      { path: "docs", kind: "folder" },
      { path: "README.md", kind: "file" },
    ]);
  });
});

describe("checking copy", () => {
  test("resolves entries that exist, in the order listed", async () => {
    const rootDir = makePackage();
    expect(await run(resolveCopyEntries({ rootDir, copy: ["README.md", "docs", "docs/guide.md"], extraReservedPaths: [] }))).toEqual([
      { path: "README.md", kind: "file" },
      { path: "docs", kind: "folder" },
      { path: "docs/guide.md", kind: "file" },
    ]);
  });

  test("refuses every reserved path, naming each, a nested node_modules and an extending abstract's output included", async () => {
    const rootDir = makePackage();
    const copy = ["package.json", "src", "src/index.ts", "dist/base", "bin", "postinstall.cjs", "package.schema.json", "node_modules", ".git/HEAD", "test/fixture/node_modules", "template"];
    const result = await runResult(resolveCopyEntries({ rootDir, copy, extraReservedPaths: ["template"] }));
    expect(Result.isFailure(result)).toBe(true);
    const message = Result.isFailure(result) ? result.failure : "";
    for (const path of copy) expect(message).toContain(`"${path}" is reserved`);
  });

  test("refuses an entry that does not exist", async () => {
    const rootDir = makePackage();
    const result = await runResult(resolveCopyEntries({ rootDir, copy: ["README.md", "CHANGELOG.md"], extraReservedPaths: [] }));
    expect(result).toEqual(Result.fail('jive.library.copy has a bad entry:\n  "CHANGELOG.md" does not exist in the package'));
  });

  test("refuses a path not written from the package root, and one listed twice", async () => {
    const rootDir = makePackage();
    const result = await runResult(resolveCopyEntries({ rootDir, copy: ["./README.md", "docs/", "../outside", "LICENSE", "LICENSE"], extraReservedPaths: [] }));
    const message = Result.isFailure(result) ? result.failure : "";
    expect(message).toContain('"./README.md" must be a path from the package root');
    expect(message).toContain('"docs/" must be a path from the package root');
    expect(message).toContain('"../outside" must be a path from the package root');
    expect(message).toContain('"LICENSE" is listed more than once');
  });
});
