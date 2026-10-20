import type { Option } from "effect";
import type { EffectGen } from "effective-modules";

/**
 * What the install script wrote down when it registered a daemon with the operating system.
 *
 * The record carries the commands and files that undo the registration rather than leaving the daemon to
 * re-derive them: the installer is plain JavaScript running inside an npm lifecycle script, the daemon is a
 * compiled binary, and two implementations of "which launchd label did we choose" would eventually disagree.
 * One side decides, writes it down, and the other reads it.
 */
/** Which service manager holds a registration, and therefore how its status is read. */
export type DaemonUnitKind = "launchd" | "systemd" | "scheduled-task";

export interface DaemonRegistration {
  /**
   * `jive-daemon.<package>.<daemon>.<digest of packageDir>`. The digest is what decides how many of a
   * daemon exist: a reinstall of the same copy replaces the registration at this id, while a second copy
   * installed elsewhere gets its own. The whole string is also the launchd label, the systemd unit base and
   * the scheduled task name, so one identifier names this daemon everywhere.
   */
  readonly id: string;
  /** The `src/daemons/` entry this came from, which is also the command name inside the binary. */
  readonly name: string;
  readonly packageName: string;
  /** Where the installed package lives. One registration per package directory, per daemon. */
  readonly packageDir: string;
  /** The daemon's working directory: the tree it was installed into, or packageDir if it is not in one. */
  readonly workingDirectory: string;
  /** Recorded so a daemon's status can be read later without guessing which registrar ran. */
  readonly kind: DaemonUnitKind;
  /** What the service manager calls it: the launchd label, the systemd unit, or the task name. */
  readonly unit: string;
  readonly logPath: string;
  /** The binary to run. A path inside the package's bin directory, so an upgrade re-links it in place. */
  readonly executable: string;
  readonly registeredAt: string;
  /** Files the installer created for this registration — the unit file, any shim, this record. */
  readonly files: ReadonlyArray<string>;
  /** Argv that deregisters the daemon with the OS. Empty when the platform needed no such step. */
  readonly unregister: ReadonlyArray<string>;
}

/** Whether a registered daemon is actually running, as its service manager reports it. */
export interface DaemonStatus {
  readonly registration: DaemonRegistration;
  readonly state: "running" | "stopped" | "unknown";
  readonly pid: Option.Option<number>;
  /** False when the registration outlived the package it points at — an orphan waiting to be cleaned up. */
  readonly executableExists: boolean;
}

export interface IDaemon {
  /**
   * Daemon entry names found in `src/daemons/`, sorted. This is the authority on which daemons a package
   * has: `jive.library.daemons` declares their scope, but the files decide that they exist.
   */
  discoverNames(rootDir: string): EffectGen<ReadonlyArray<string>, string>;
  /** The registration this process is running under, named by the `JIVE_DAEMON_ID` its unit file sets. */
  currentRegistration(): EffectGen<Option.Option<DaemonRegistration>, string>;
  /**
   * Every daemon registered on this machine, by any package, sorted by id. Reading the registry rather
   * than the service manager: the registry is the one cross-platform list, and it is written by whoever
   * installed each daemon.
   */
  list(): EffectGen<ReadonlyArray<DaemonRegistration>, string>;
  /** Asks the service manager that holds a registration whether it is running. */
  status(registration: DaemonRegistration): EffectGen<DaemonStatus, string>;
  /**
   * Undoes a registration using the record's own instructions, so a daemon whose package has been
   * uninstalled stops being started at login instead of failing at every login forever.
   */
  deregister(registration: DaemonRegistration): EffectGen<void, string>;
}
