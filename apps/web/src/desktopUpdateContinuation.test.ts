import { describe, expect, it } from "vitest";

import {
  buildDesktopUpdateInterruptionConfirmation,
  collectRunningDesktopUpdateTurns,
  DESKTOP_UPDATE_CONTINUATION_PROMPT,
  isDesktopUpdateContinuationApplicable,
} from "./desktopUpdateContinuation";
import type { SidebarThreadSummary } from "./types";

function thread(
  id: string,
  turnId: string | null,
  state: "running" | "interrupted" | "completed" | "error" | null,
): SidebarThreadSummary {
  return {
    id,
    projectId: "project-1",
    title: id,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    latestTurn:
      turnId && state
        ? {
            turnId,
            state,
            requestedAt: "2026-07-31T00:00:00.000Z",
            startedAt: "2026-07-31T00:00:01.000Z",
            completedAt: state === "running" ? null : "2026-07-31T00:01:00.000Z",
            assistantMessageId: null,
          }
        : null,
    latestUserMessageAt: "2026-07-31T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: state === "running",
  } as SidebarThreadSummary;
}

describe("desktopUpdateContinuation", () => {
  it("captures only exact running turns", () => {
    const sessionRunningThread = {
      ...thread("session-running", "turn-stale", "completed"),
      session: {
        status: "running",
        orchestrationStatus: "running",
        activeTurnId: "turn-active",
      },
    } as SidebarThreadSummary;
    expect(
      collectRunningDesktopUpdateTurns([
        thread("running", "turn-running", "running"),
        sessionRunningThread,
        thread("completed", "turn-completed", "completed"),
        thread("idle", null, null),
      ]),
    ).toEqual([
      { threadId: "running", turnId: "turn-running" },
      { threadId: "session-running", turnId: "turn-active" },
    ]);
  });

  it("recognizes only the unfinished turn recorded by the update", () => {
    const matchingInterruptedThread = thread("thread-1", "turn-1", "interrupted");
    const matchingFailedThread = thread("thread-1", "turn-1", "error");
    const differentInterruptedThread = thread("thread-1", "turn-2", "interrupted");
    const matchingCompletedThread = thread("thread-1", "turn-1", "completed");
    const continuation = {
      threadId: matchingInterruptedThread.id,
      turnId: matchingInterruptedThread.latestTurn!.turnId,
    };

    expect(
      isDesktopUpdateContinuationApplicable(
        continuation,
        matchingInterruptedThread.id,
        matchingInterruptedThread.latestTurn!.turnId,
        matchingInterruptedThread.latestTurn!.state,
      ),
    ).toBe(true);
    expect(
      isDesktopUpdateContinuationApplicable(
        continuation,
        matchingFailedThread.id,
        matchingFailedThread.latestTurn!.turnId,
        matchingFailedThread.latestTurn!.state,
      ),
    ).toBe(true);
    expect(
      isDesktopUpdateContinuationApplicable(
        continuation,
        differentInterruptedThread.id,
        differentInterruptedThread.latestTurn!.turnId,
        differentInterruptedThread.latestTurn!.state,
      ),
    ).toBe(false);
    expect(
      isDesktopUpdateContinuationApplicable(
        continuation,
        matchingCompletedThread.id,
        matchingCompletedThread.latestTurn!.turnId,
        matchingCompletedThread.latestTurn!.state,
      ),
    ).toBe(false);
  });

  it("warns before interrupting active work and uses a side-effect-safe continuation prompt", () => {
    expect(buildDesktopUpdateInterruptionConfirmation("0.7.0", 2)).toContain(
      "2 running tasks will be interrupted",
    );
    expect(DESKTOP_UPDATE_CONTINUATION_PROMPT).toContain("do not repeat side effects");
  });
});
