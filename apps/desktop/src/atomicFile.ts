// FILE: atomicFile.ts
// Purpose: Writes small private text records atomically for desktop crash recovery paths.
// Layer: Desktop filesystem utility

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

/**
 * Replaces a small private text file only after its full contents reach disk.
 * The caller owns validation; this helper only provides the durable replacement.
 */
export function writePrivateTextFileAtomicallySync(filePath: string, contents: string): void {
  const directory = Path.dirname(filePath);
  FS.mkdirSync(directory, { recursive: true });
  const temporaryPath = Path.join(
    directory,
    `.${Path.basename(filePath)}.${process.pid}.${Crypto.randomUUID()}.tmp`,
  );
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = FS.openSync(temporaryPath, "wx", 0o600);
    FS.writeFileSync(fileDescriptor, contents, "utf8");
    FS.fsyncSync(fileDescriptor);
    FS.closeSync(fileDescriptor);
    fileDescriptor = null;
    FS.renameSync(temporaryPath, filePath);
  } finally {
    try {
      if (fileDescriptor !== null) {
        FS.closeSync(fileDescriptor);
      }
    } finally {
      FS.rmSync(temporaryPath, { force: true });
    }
  }
}
