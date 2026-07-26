import { CheckpointRef, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  isTurnDiffSummaryReviewable,
  resolveTurnDiffAvailability,
  resolveTurnDiffCacheScope,
  resolveTurnDiffMenuStatus,
} from "./turnDiffAvailability";

describe("turn diff availability", () => {
  it("keeps live provider summaries pending and non-reviewable", () => {
    const summary = {
      turnId: TurnId.makeUnsafe("turn-live"),
      checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-1"),
      status: "missing",
      files: [{ path: "src/live.ts" }],
    };

    expect(resolveTurnDiffAvailability(summary)).toBe("pending");
    expect(isTurnDiffSummaryReviewable(summary)).toBe(false);
    expect(resolveTurnDiffMenuStatus(summary)).toBe("Preparing");
  });

  it("distinguishes unavailable checkpoints from ready turns with no changes", () => {
    const unavailable = {
      checkpointRef: CheckpointRef.makeUnsafe("refs/synara/checkpoint"),
      status: "error",
      files: [{ path: "src/broken.ts" }],
    };
    const empty = {
      checkpointRef: CheckpointRef.makeUnsafe("refs/synara/ready"),
      status: "ready",
      files: [],
    };

    expect(resolveTurnDiffAvailability(unavailable)).toBe("unavailable");
    expect(resolveTurnDiffMenuStatus(unavailable)).toBe("Unavailable");
    expect(isTurnDiffSummaryReviewable(empty)).toBe(true);
    expect(resolveTurnDiffMenuStatus(empty)).toBe("No changes");
  });

  it("changes cache scope when a placeholder becomes a durable checkpoint", () => {
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      resolveTurnDiffCacheScope({
        turnId,
        checkpointRef: CheckpointRef.makeUnsafe("provider-diff:event-1"),
        status: "missing",
      }),
    ).not.toBe(
      resolveTurnDiffCacheScope({
        turnId,
        checkpointRef: CheckpointRef.makeUnsafe("refs/synara/thread/turn/1"),
        status: "ready",
      }),
    );
  });
});
