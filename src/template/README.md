# example-library

A library that [`jive-abstract-library`](https://www.npmjs.com/package/jive-abstract-library) builds and publishes to
npm: each `jive:cicd:*` script in `package.json` runs that abstract's `jive-library` CLI, and a push to `main` with a new
`version` publishes it.

What it exports is in [`src/index.ts`](src/index.ts). A command it ships goes in `src/entrypoints/<command>.ts`, and the
build compiles it into a binary for each platform.
