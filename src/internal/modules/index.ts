import { interfaces } from "effective-modules";
import type { IOSPlatform } from "./os-platform/interface";
import type { IGit } from "./git/interface";
import type { IPackage } from "./package/interface";
import type { IJsonSchema } from "./json-schema/interface";
import type { IBuilder } from "./builder/interface";
import type { INpm } from "./npm/interface";
import type { IDeployer } from "./deployer/interface";
import type { IDaemon } from "./daemon/interface";
import type { IInstalledPackage } from "./installed-package/interface";
import type { IJiveServer } from "./jive-server/interface";
import type { IShellCompletion } from "./shell-completion/interface";

export enum LibraryModules {
  OSPlatform = "OSPlatform",
  Git = "Git",
  Package = "Package",
  JsonSchema = "JsonSchema",
  Builder = "Builder",
  Npm = "Npm",
  Deployer = "Deployer",
  Daemon = "Daemon",
  InstalledPackage = "InstalledPackage",
  JiveServer = "JiveServer",
  ShellCompletion = "ShellCompletion",
}

export const libraryModules = interfaces<LibraryModules, {
  OSPlatform: IOSPlatform;
  Git: IGit;
  Package: IPackage;
  JsonSchema: IJsonSchema;
  Builder: IBuilder;
  Npm: INpm;
  Deployer: IDeployer;
  Daemon: IDaemon;
  InstalledPackage: IInstalledPackage;
  JiveServer: IJiveServer;
  ShellCompletion: IShellCompletion;
}>(LibraryModules);
