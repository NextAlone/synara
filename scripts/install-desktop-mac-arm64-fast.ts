// FILE: install-desktop-mac-arm64-fast.ts
// Purpose: Build an unpacked ARM64 macOS app and replace the local /Applications copy.
// Layer: Local developer installation entry point

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fastInstallMacApp } from "./lib/mac-fast-install.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(repoRoot, "release", "mac-arm64");
const sourceAppPath = join(outputDirectory, "Synara.app");
const destinationAppPath = "/Applications/Synara.app";

function runFastAppBuild(): void {
  const result = spawnSync(
    process.execPath,
    [
      join(repoRoot, "scripts", "build-desktop-artifact.ts"),
      "--platform",
      "mac",
      "--target",
      "dir",
      "--arch",
      "arm64",
      "--output-dir",
      outputDirectory,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`Fast desktop app build failed with exit code ${String(result.status)}.`);
  }
}

if (process.platform !== "darwin") {
  throw new Error("Fast desktop installation is supported only on macOS.");
}

runFastAppBuild();
if (!existsSync(sourceAppPath)) {
  throw new Error(`Fast desktop build did not produce ${sourceAppPath}.`);
}

const result = fastInstallMacApp({ sourceAppPath, destinationAppPath });
console.log(
  `[desktop-fast-install] Installed Synara.app to ${result.destinationAppPath}${
    result.replacedExistingApp ? " (replaced existing app)" : ""
  }. Restart Synara to run the new build.`,
);
