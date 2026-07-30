import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { copyMacAppBundle } from "./mac-app-bundle.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function createAppBundle(root: string): string {
  const appPath = join(root, "Synara.app");
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
  writeFileSync(join(resourcesPath, "app.asar"), "app");
  writeFileSync(join(frameworkVersionPath, "Electron Framework"), "framework");
  symlinkSync("A", join(frameworkPath, "Versions", "Current"));
  symlinkSync(
    join("Versions", "Current", "Electron Framework"),
    join(frameworkPath, "Electron Framework"),
  );
  return appPath;
}

describe("copyMacAppBundle", () => {
  it("preserves relative Electron framework symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "synara-mac-app-copy-"));
    temporaryRoots.push(root);
    const sourceAppPath = createAppBundle(join(root, "source"));
    const destinationAppPath = join(root, "destination", "Synara.app");
    mkdirSync(join(root, "destination"));

    copyMacAppBundle(sourceAppPath, destinationAppPath);

    const copiedFrameworkPath = join(
      destinationAppPath,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
    );
    expect(readlinkSync(join(copiedFrameworkPath, "Versions", "Current"))).toBe("A");
    expect(readlinkSync(join(copiedFrameworkPath, "Electron Framework"))).toBe(
      join("Versions", "Current", "Electron Framework"),
    );
    expect(existsSync(join(copiedFrameworkPath, "Electron Framework"))).toBe(true);
  });
});
