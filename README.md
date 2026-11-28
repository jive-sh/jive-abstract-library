# jive-abstract-library

The [Jive](https://github.com/jive-sh/jive) abstract for npm libraries and command-line tools. A package extends it
by pointing its six CI/CD scripts at this package's CLI, `jive-library`. From then on it gets, with no CI
configuration of its own:

- a build that type-checks and emits its TypeScript, compiles each of its commands into a standalone binary for
  macOS, Linux and Windows, and lays the result out as npm packages;
- a publish to npm on every push to a branch it deploys, skipped when that version is already on the registry;
- a JSON Schema for the `jive` block of its `package.json`, so an editor completes and checks it;
- one strict `tsconfig.json` shared with every other package built with this abstract.

`jive create library` makes a new package of this kind from [`src/template/`](src/template/).

## A package built with it

```json
{
  "$schema": "./package.schema.json",
  "name": "@my-scope/my-library",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "jive:cicd:get-config": "jive-library cicd get-config",
    "jive:cicd:build": "jive-library cicd build",
    "jive:cicd:audit": "tsc --noEmit -p tsconfig.json && bun test src",
    "jive:cicd:deploy:plan": "jive-library cicd deploy-plan",
    "jive:cicd:upload-artifacts": "jive-library cicd upload-artifacts",
    "jive:cicd:deploy": "jive-library cicd deploy",
    "dev": "jive-library dev"
  },
  "devDependencies": { "jive-abstract-library": "<this package's version>" },
  "jive": {
    "cicd": {
      "deploy": { "verb": "Publish Tag", "branches": { "main": ["latest"] }, "previews": false, "sequentially": true },
      "runsOnPullRequests": true,
      "runsOn": "ubuntu-latest",
      "requiredSecrets": ["NPM_TOKEN"]
    },
    "library": { "daemons": [], "copy": ["README.md"], "provisionWithJive": null }
  }
}
```

Its `tsconfig.json` is one line:

```json
{ "extends": "jive-abstract-library/tsconfig.json" }
```

What each folder under `src` means:

| Path | Means |
| --- | --- |
| `src/index.ts` | The library's exports, published as the package's `"."` export |
| `src/entrypoints/<command>.ts` | One command on the installer's PATH, named after the file |
| `src/daemons/<name>.ts` | A daemon started at login, which `jive.library.daemons` must list |

## The six hooks

Jive's reusable pipeline runs each `jive:cicd:*` script with no arguments
([`CICD_API.md`](https://github.com/jive-sh/jive/blob/main/CICD_API.md) is the contract).

| Hook | What `jive-library` does |
| --- | --- |
| `get-config` | Prints the package's `jive` block, checked against the schema, as JSON on stdout |
| `build` | Builds `dist/base` and one package per platform under `dist/`, writes `package.schema.json`, then installs the result on this machine, so the audit sees the package as a consumer would |
| `audit` | Nothing; a package runs its own checks here (`tsc` and `bun test` above) |
| `deploy-plan` | Prints `{"deploy":false}` when npm already lists the environment's version, else `{"deploy":true,"url":"<its npm page>"}` |
| `upload-artifacts` | Nothing; publishing happens in `deploy`, per environment |
| `deploy` | Stamps the packages with the environment's version (bare on `latest`, a prerelease elsewhere), provisions the package with Jive when `provisionWithJive` says so, and publishes them under the environment's dist-tag |

A push without a version bump publishes nothing: `deploy-plan` finds the version on npm. `jive-library dev` keeps
`package.schema.json` current while `package.json` and `src` change.

## The `library` block

Every field is required: the schema is how an author finds out what can be configured.

- **`daemons`**: every `src/daemons/` entry, by file name without its extension. The build fails if this list and the
  files disagree.
- **`copy`**: the files and folders, by path from the package root, that the build copies verbatim into the published
  package and adds to its `files` and `exports` (a file as `"./<path>"`, a folder as `"./<path>/*"`). A README or
  LICENSE ships only when `copy` lists it. Anything the build generates or manages can't be listed: `package.json`,
  `package.schema.json`, `src`, `dist`, `bin`, `postinstall.cjs`, and a `node_modules` or `.git` folder at any depth.
  An abstract extending this one reserves what its own build writes too (`jive-abstract-abstraction` reserves
  `template`). The generated `package.schema.json` offers exactly the package's other files and folders, and the
  build fails, naming each entry, on one that is reserved, doesn't exist, isn't written from the package root, or is
  listed twice.
- **`provisionWithJive`**: `null` to publish to npm directly, or `{"serverUrl": "https://api.jive.sh"}` to have each
  deploy sign in to that Jive server with the job's GitHub OIDC token and ask it to provision the package right
  before publishing. The deploy publishes nothing if Jive refuses.

`files`, `exports` and `repository` are refused in a source `package.json`: the build writes them.

## The shared tsconfig

This package publishes its own root [`tsconfig.json`](tsconfig.json) through `copy`, and every package built with it
extends that file, this package included. It sets Bun's bundler-mode TypeScript (`module` `Preserve`,
`moduleResolution` `bundler`, `noEmit`, `types` `["bun"]`, `preserveSymlinks`), then `strict` and these checks:
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noImplicitReturns`,
`noUnusedLocals`, `noUnusedParameters`, `noPropertyAccessFromIndexSignature`, `noFallthroughCasesInSwitch` and
`noUncheckedSideEffectImports`, with `allowUnreachableCode` and `allowUnusedLabels` off.

- Its `include` and `exclude` use `${configDir}`, so they name the extending package's own `src`, `dist` and
  `node_modules`, never this package's.
- A package also type-checks the `.ts` source its dependencies ship, since `skipLibCheck` skips only `.d.ts` files.
  So a package passes these checks only once every dependency that ships source passes them too.
- **A path alias stays in the package's own `tsconfig.json`**, beside the `extends`. Bun resolves an extended file's
  `paths` from that file's folder and doesn't substitute `${configDir}` there, so an alias in the shared file would
  point into `node_modules/jive-abstract-library`:

```json
{ "extends": "jive-abstract-library/tsconfig.json", "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }
```

## For abstracts extending this one

Every other abstract builds its CLI from this package's exports in [`src/index.ts`](src/index.ts) rather than
restating them: `Cli` (the command tree, its help and Tab completion), `makeCicdCommandFactory` (the six hooks' input
reading, output printing and exit codes), `makeJivePackageJsonSchema` (the fields every Jive package has, plus the
abstract's own block), `discoverLibrarySchema` and `resolveCopyEntries` (the `library` block narrowed to a package's
files, and the build's check of `copy`, each taking the paths the abstract's own build writes), and the release
helpers (`releaseVersion`, `planNpmRelease`, `publishPackage`).

## Developing

```sh
bun install
bun run jive:cicd:audit   # type check and tests
bun run jive:cicd:build   # dist/base and the platform packages, a local install, then the template step
```

This package builds itself from source, then runs `jive-abstraction build-template` from its devDependency on
`jive-abstract-abstraction`, which turns `src/template/` into the template `jive create library` renders.

Run tests and builds on a person's machine with `HOME` set to a scratch folder inside the package (`.scratch/` is
gitignored): a build's local install sets up Tab completion in the home folder's shell files.
