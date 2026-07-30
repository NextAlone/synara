// FILE: mac-fast-install.ts
// Purpose: Atomically replace a local macOS app bundle after an app-only build.
// Layer: Local developer installation helper

import { existsSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { assertMacAppBundle, copyMacAppBundle } from "./mac-app-bundle.ts";

export interface FastMacAppInstallOptions {
  readonly sourceAppPath: string;
  readonly destinationAppPath: string;
}

export interface FastMacAppInstallResult {
  readonly destinationAppPath: string;
  readonly replacedExistingApp: boolean;
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true, recursive: true });
  }
}

export function fastInstallMacApp({
  sourceAppPath,
  destinationAppPath,
}: FastMacAppInstallOptions): FastMacAppInstallResult {
  assertMacAppBundle(sourceAppPath, "Source app bundle");

  const destinationDirectory = dirname(destinationAppPath);
  if (!existsSync(destinationDirectory)) {
    throw new Error(`Installation directory is missing: ${destinationDirectory}.`);
  }

  const appName = basename(destinationAppPath);
  const appStem = appName.slice(0, -".app".length);
  const installToken = `${process.pid}-${Date.now()}`;
  const stagedAppPath = join(destinationDirectory, `.${appStem}.installing-${installToken}.app`);
  const backupAppPath = join(destinationDirectory, `.${appStem}.backup-${installToken}.app`);
  const replacedExistingApp = existsSync(destinationAppPath);

  try {
    copyMacAppBundle(sourceAppPath, stagedAppPath);

    if (replacedExistingApp) {
      renameSync(destinationAppPath, backupAppPath);
    }

    try {
      renameSync(stagedAppPath, destinationAppPath);
      assertMacAppBundle(destinationAppPath, "Installed app bundle");
    } catch (error) {
      removeIfPresent(destinationAppPath);
      if (replacedExistingApp && existsSync(backupAppPath)) {
        renameSync(backupAppPath, destinationAppPath);
      }
      throw error;
    }

    removeIfPresent(backupAppPath);
    return { destinationAppPath, replacedExistingApp };
  } finally {
    removeIfPresent(stagedAppPath);
  }
}
