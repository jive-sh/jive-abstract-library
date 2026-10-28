import { libraryModules } from "../modules";

/**
 * Running host processes and reading facts about the host, for a package's own modules to depend on
 * (`implementing(x).uses(OSPlatform)`, then `this.dependencies.OSPlatform`). Provide `OSPlatformImpl.Layer`.
 */
export const OSPlatform = libraryModules.OSPlatform;
export { OSPlatformImpl } from "../modules/os-platform/impl";
export type { IOSPlatform, ProcessResult, ProcessStdio, SpawnProcessInput } from "../modules/os-platform/interface";
