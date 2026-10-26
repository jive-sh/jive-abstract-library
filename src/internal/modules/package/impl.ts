import { FileSystem, pipe, Effect } from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { PackageJsonSchema, type PackageJson } from "../../public/manifest";
import { loadPackageJson } from "../../public/package-json";
import { libraryModules } from "../index";
import type { IPackage } from "./interface";

export class PackageImpl extends implementing(libraryModules.Package).uses(FileSystem.FileSystem) implements IPackage {
  *load(): EffectGen<PackageJson, string> {
    return yield* pipe(
      loadPackageJson(PackageJsonSchema),
      Effect.provideService(FileSystem.FileSystem, this.getDependency(FileSystem.FileSystem)),
    );
  }
}
