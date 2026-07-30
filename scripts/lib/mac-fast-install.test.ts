import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fastInstallMacApp } from "./mac-fast-install.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createAppBundle(root: string, appName: string, appAsarContents: string): string {
  const appPath = join(root, appName);
  const resourcesPath = join(appPath, "Contents", "Resources");
  const frameworkPath = join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  const frameworkVersionPath = join(frameworkPath, "Versions", "A");
  mkdirSync(resourcesPath, { recursive: true });
  mkdirSync(frameworkVersionPath, { recursive: true });
  writeFileSync(join(resourcesPath, "app.asar"), appAsarContents);
  writeFileSync(join(frameworkVersionPath, "Electron Framework"), "framework");
  symlinkSync("A", join(frameworkPath, "Versions", "Current"));
  symlinkSync(
    join("Versions", "Current", "Electron Framework"),
    join(frameworkPath, "Electron Framework"),
  );
  return appPath;
}

describe("fastInstallMacApp", () => {
  it("installs an app bundle into an empty destination", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-fast-install-"));
    temporaryRoots.push(root);
    const sourceAppPath = createAppBundle(root, "Synara.app", "new bundle");
    const destinationAppPath = join(root, "Applications", "Synara.app");
    mkdirSync(join(root, "Applications"));

    const result = fastInstallMacApp({ sourceAppPath, destinationAppPath });

    expect(result).toEqual({ destinationAppPath, replacedExistingApp: false });
    expect(readFileSync(join(destinationAppPath, "Contents", "Resources", "app.asar"), "utf8")).toBe(
      "new bundle",
    );
    expect(readdirSync(join(root, "Applications"))).toEqual(["Synara.app"]);
  });

  it("replaces an existing app bundle only after staging the new one", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-fast-install-"));
    temporaryRoots.push(root);
    const sourceAppPath = createAppBundle(root, "Synara.app", "new bundle");
    const applicationsPath = join(root, "Applications");
    mkdirSync(applicationsPath);
    const destinationAppPath = createAppBundle(applicationsPath, "Synara.app", "old bundle");

    const result = fastInstallMacApp({ sourceAppPath, destinationAppPath });

    expect(result).toEqual({ destinationAppPath, replacedExistingApp: true });
    expect(readFileSync(join(destinationAppPath, "Contents", "Resources", "app.asar"), "utf8")).toBe(
      "new bundle",
    );
    expect(readdirSync(applicationsPath)).toEqual(["Synara.app"]);
  });

  it("refuses a source that is not a packaged app bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-fast-install-"));
    temporaryRoots.push(root);
    const applicationsPath = join(root, "Applications");
    mkdirSync(applicationsPath);
    const sourceAppPath = join(root, "Synara.app");
    mkdirSync(sourceAppPath);
    const destinationAppPath = createAppBundle(applicationsPath, "Synara.app", "old bundle");

    expect(() => fastInstallMacApp({ sourceAppPath, destinationAppPath })).toThrow(
      "Source app bundle is missing Contents/Resources/app.asar",
    );
    expect(readFileSync(join(destinationAppPath, "Contents", "Resources", "app.asar"), "utf8")).toBe(
      "old bundle",
    );
  });
});
