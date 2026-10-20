import type { EffectGen } from "effective-modules";
import type { PackageJson } from "../../public/manifest";

export interface IPackage {
  /** Reads and validates the working directory's package.json against the template's schema. */
  load(): EffectGen<PackageJson, string>;
}
