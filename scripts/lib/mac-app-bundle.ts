// FILE: mac-app-bundle.ts
// Purpose: Validate and copy packaged macOS app bundles without breaking framework symlinks.
// Layer: Local packaging utility

import { cpSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const APP_ASAR_PATH = ["Contents", "Resources", "app.asar"] as const;
const ELECTRON_FRAMEWORK_EXECUTABLE_PATH = [
  "Contents",
  "Frameworks",
  "Electron Framework.framework",
  "Electron Framework",
] as const;

export function assertMacAppBundle(path: string, label: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing at ${path}.`);
  }
  if (!stat.isDirectory() || !path.endsWith(".app")) {
    throw new Error(`${label} must be a macOS .app bundle: ${path}.`);
  }

  if (!existsSync(join(path, ...APP_ASAR_PATH))) {
    throw new Error(`${label} is missing Contents/Resources/app.asar: ${path}.`);
  }
  if (!existsSync(join(path, ...ELECTRON_FRAMEWORK_EXECUTABLE_PATH))) {
    throw new Error(
      `${label} is missing a usable Electron Framework executable: ${path}.`,
    );
  }
}

export function copyMacAppBundle(sourceAppPath: string, destinationAppPath: string): void {
  assertMacAppBundle(sourceAppPath, "Source app bundle");
  cpSync(sourceAppPath, destinationAppPath, {
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    recursive: true,
    verbatimSymlinks: true,
  });
  assertMacAppBundle(destinationAppPath, "Copied app bundle");
}
