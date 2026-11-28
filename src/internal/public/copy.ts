import { Effect, FileSystem, PlatformError } from "effect";
import { posix, relative, resolve, sep } from "node:path";
import {
  BIN_DIR,
  GIT_DIR,
  NODE_MODULES_DIR,
  OUTDIR,
  PACKAGE_JSON_FILE,
  PACKAGE_SCHEMA_FILE,
  POSTINSTALL_SCRIPT,
  SOURCE_DIR,
} from "../common/constants";

/**
 * `jive.library.copy`: files and folders of a package, by path from its root, that the build copies verbatim into the
 * published package and lists in its `files` and `exports`.
 *
 * Every path the build generates or manages is reserved; everything else in the package may be copied. The same
 * listing of the package's files decides both what the editor offers (the generated schema's enum) and what the build
 * accepts, so the two cannot disagree.
 */

/** Paths the build writes into the published package or manages itself, from the package root. */
export const RESERVED_COPY_PATHS: ReadonlyArray<string> = [
  PACKAGE_JSON_FILE,
  PACKAGE_SCHEMA_FILE,
  SOURCE_DIR,
  OUTDIR,
  BIN_DIR,
  POSTINSTALL_SCRIPT,
  NODE_MODULES_DIR,
  GIT_DIR,
];

/** Folders a package manager or git manages wherever they sit, a test fixture's own node_modules included. */
const RESERVED_FOLDER_NAMES: ReadonlyArray<string> = [NODE_MODULES_DIR, GIT_DIR];

export interface CopyablePathsInput {
  readonly rootDir: string;
  /** Paths an extending abstract's build writes into the published package, reserved on top of this abstract's. */
  readonly extraReservedPaths: ReadonlyArray<string>;
}

export interface CheckCopyInput extends CopyablePathsInput {
  readonly copy: ReadonlyArray<string>;
}

export type CopyKind = "file" | "folder";

export interface CopyEntry {
  readonly path: string;
  readonly kind: CopyKind;
}

function isReserved(path: string, reservedPaths: ReadonlyArray<string>): boolean {
  const segments = path.split("/");
  return reservedPaths.some((reserved) => path === reserved || path.startsWith(`${reserved}/`))
    || segments.some((segment) => RESERVED_FOLDER_NAMES.includes(segment));
}

/**
 * Every file and folder under the package root that `jive.library.copy` may name, as sorted forward-slash paths. Reserved
 * folders are never entered, and a folder reached twice through a symlink is listed once.
 */
export function listCopyableEntries(input: CopyablePathsInput): Effect.Effect<ReadonlyArray<CopyEntry>, string, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const reservedPaths = [...RESERVED_COPY_PATHS, ...input.extraReservedPaths];
    const visited = new Set<string>();
    const entries: Array<CopyEntry> = [];

    const walk = (dir: string): Effect.Effect<void, PlatformError.PlatformError> => Effect.gen(function* () {
      const real = yield* fs.realPath(dir);
      if (visited.has(real)) return;
      visited.add(real);
      for (const child of [...(yield* fs.readDirectory(dir))].sort()) {
        const absolute = resolve(dir, child);
        const path = relative(input.rootDir, absolute).split(sep).join("/");
        if (isReserved(path, reservedPaths)) continue;
        const kind: CopyKind = (yield* fs.stat(absolute)).type === "Directory" ? "folder" : "file";
        entries.push({ path, kind });
        if (kind === "folder") yield* walk(absolute);
      }
    });
    yield* walk(input.rootDir);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }).pipe(Effect.mapError((e) => (typeof e === "string" ? e : e.message)));
}

/** The paths `listCopyableEntries` finds, which the generated schema offers as `jive.library.copy`'s only values. */
export function listCopyablePaths(input: CopyablePathsInput): Effect.Effect<ReadonlyArray<string>, string, FileSystem.FileSystem> {
  return Effect.map(listCopyableEntries(input), (entries) => entries.map((entry) => entry.path));
}

/**
 * Resolves a package's `jive.library.copy` against its files, failing, with every bad entry named, when an entry is
 * reserved, missing, not written as a path from the package root, or listed twice.
 */
export function resolveCopyEntries(input: CheckCopyInput): Effect.Effect<ReadonlyArray<CopyEntry>, string, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const copyable = new Map((yield* listCopyableEntries(input)).map((entry) => [entry.path, entry]));
    const reservedPaths = [...RESERVED_COPY_PATHS, ...input.extraReservedPaths];
    const problems: Array<string> = [];
    const resolved: Array<CopyEntry> = [];

    for (const [index, path] of input.copy.entries()) {
      const entry = copyable.get(path);
      if (input.copy.indexOf(path) !== index) {
        problems.push(`"${path}" is listed more than once`);
      } else if (entry !== undefined) {
        resolved.push(entry);
      } else if (posix.isAbsolute(path) || posix.normalize(path) !== path || path.startsWith("../") || path.endsWith("/")) {
        problems.push(`"${path}" must be a path from the package root with no "./", "..", or trailing "/", e.g. "README.md" or "docs"`);
      } else if (isReserved(path, reservedPaths)) {
        problems.push(`"${path}" is reserved: the build generates or manages ${reservedPaths.map((reserved) => `"${reserved}"`).join(", ")}, and a node_modules or .git folder at any depth`);
      } else {
        problems.push(`"${path}" does not exist in the package`);
      }
    }

    if (problems.length > 0) {
      return yield* Effect.fail(`jive.library.copy has ${problems.length === 1 ? "a bad entry" : "bad entries"}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
    }
    return resolved;
  });
}
