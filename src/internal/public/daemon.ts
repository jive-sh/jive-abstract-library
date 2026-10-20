import { Effect, FileSystem, Layer, Logger, Option, pipe } from "effect";
import { BunFileSystem } from "@effect/platform-bun";
import { effunct, type EffectGen } from "effective-modules";
import { stderrLogger } from "../common/logger";
import type { LibraryModules } from "../modules";
import { libraryModules } from "../modules";
import { DaemonImpl } from "../modules/daemon/impl";
import type { DaemonStatus } from "../modules/daemon/interface";
import { OSPlatformImpl } from "../modules/os-platform/impl";

/**
 * Only what supervision needs, rather than this package's whole module graph.
 *
 * This runs inside *other* packages' daemons, which are Bun-compiled single-file binaries — so the graph
 * reached from here is the graph bundled into them. The full layer pulls in the builder, and with it
 * `ejs` and `commander`, none of which a signing agent has any use for.
 */
const layer = pipe(
  DaemonImpl.Layer,
  Layer.provideMerge(OSPlatformImpl.Layer),
  Layer.provideMerge(BunFileSystem.layer),
) satisfies Layer.Layer<any, any, never>;

/**
 * The one thing every registered daemon has to do, offered as a single call so no daemon has to remember it.
 *
 * Nothing else can do this. `npm uninstall` deletes the package directory; it knows nothing about the
 * launchd agent, systemd unit or scheduled task that points into it, so without this the operating system
 * goes on trying to start a missing executable at every login, forever. The daemon is the last thing in a
 * position to notice, so noticing is part of being one.
 *
 * Fire and forget: it returns immediately, and does nothing at all unless this process was started from a
 * registration. A daemon run by hand has none, and one appearing later would mean a reinstall, which
 * restarts the process anyway — so the check at startup is enough to decide.
 */

/** How often a supervised daemon checks that it still has a reason to exist. */
const CHECK_INTERVAL = "60 seconds";

export function exitWhenUninstalled(): void {
  Effect.runFork(pipe(
    effunct(supervise)(),
    Effect.provide(layer),
    Effect.provide(Logger.layer([stderrLogger])),
    // A daemon must not die because its own housekeeping failed; its job is whatever else it was started for.
    Effect.catchCause((cause) => Effect.log(`Stopped supervising this daemon's registration: ${String(cause)}`)),
  ));
}

function* supervise(): EffectGen<void, string, LibraryModules.Daemon | FileSystem.FileSystem> {
  const daemon = yield* libraryModules.Daemon;
  const fs = yield* FileSystem.FileSystem;
  if (Option.isNone(yield* daemon.currentRegistration())) return;

  yield* Effect.forever(Effect.gen(function* () {
    yield* Effect.sleep(CHECK_INTERVAL);
    const registration = yield* daemon.currentRegistration();
    if (Option.isNone(registration)) return;

    const executable = registration.value.executable;
    if (yield* Effect.orDie(fs.exists(executable))) return;

    yield* Effect.log(`${executable} no longer exists — removing this daemon's registration`);
    yield* daemon.deregister(registration.value);
    yield* Effect.sync(() => process.exit(0));
  }));
}

/**
 * Every Jive daemon registered on this machine, with whether it is actually running.
 *
 * Offered from here rather than left to each CLI because this package writes the registry: a second
 * implementation of "where the records live and what they mean" would be a second thing to keep in step
 * with the installer. Requirements are already provided, so a consumer can yield it directly.
 */
export const daemonStatuses: Effect.Effect<ReadonlyArray<DaemonStatus>, string> = pipe(
  effunct(collectStatuses)(),
  Effect.provide(layer),
);

function* collectStatuses(): EffectGen<ReadonlyArray<DaemonStatus>, string, LibraryModules.Daemon> {
  const daemon = yield* libraryModules.Daemon;
  const statuses: DaemonStatus[] = [];
  for (const registration of yield* daemon.list()) {
    statuses.push(yield* daemon.status(registration));
  }
  return statuses;
}
