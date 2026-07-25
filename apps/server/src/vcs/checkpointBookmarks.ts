import { createHash } from "node:crypto";

import type { CheckpointRef } from "@synara/contracts";

export const SYNARA_JJ_CHECKPOINT_BOOKMARK_PREFIX = "synara-checkpoint/";
export const SYNARA_JJ_SNAPSHOT_BOOKMARK_PREFIX = "synara-snapshot/";

export function jjCheckpointBookmark(checkpointRef: CheckpointRef): string {
  const digest = createHash("sha256").update(checkpointRef).digest("hex");
  return `${SYNARA_JJ_CHECKPOINT_BOOKMARK_PREFIX}${digest}`;
}

export function isSynaraJjCheckpointBookmark(name: string): boolean {
  return (
    name.startsWith(SYNARA_JJ_CHECKPOINT_BOOKMARK_PREFIX) ||
    name.startsWith(SYNARA_JJ_SNAPSHOT_BOOKMARK_PREFIX)
  );
}

export function exactJjBookmarkRevset(name: string): string {
  return `bookmarks(exact:${JSON.stringify(name)})`;
}
