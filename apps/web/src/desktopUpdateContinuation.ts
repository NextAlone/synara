// FILE: desktopUpdateContinuation.ts
// Purpose: Captures turns interrupted by desktop updates and exposes durable
// continuation state to the active conversation.
// Layer: Desktop update web integration

import type {
  DesktopUpdateInterruptedTurn,
  DesktopUpdateState,
  OrchestrationLatestTurnState,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { useEffect, useState } from "react";

import type { SidebarThreadSummary } from "./types";

export const DESKTOP_UPDATE_CONTINUATION_PROMPT =
  "Continue the task interrupted by the Synara update. First inspect the conversation, working tree, and completed tool actions so you do not repeat side effects, then finish the remaining work.";

export function collectRunningDesktopUpdateTurns(
  threads: readonly SidebarThreadSummary[],
): readonly DesktopUpdateInterruptedTurn[] {
  const result: DesktopUpdateInterruptedTurn[] = [];
  const seen = new Set<string>();
  for (const thread of threads) {
    const turnId =
      thread.latestTurn?.state === "running"
        ? thread.latestTurn.turnId
        : thread.session?.orchestrationStatus === "running" ||
            thread.session?.orchestrationStatus === "starting" ||
            thread.session?.status === "running" ||
            thread.session?.status === "connecting"
          ? (thread.session?.activeTurnId ?? null)
          : null;
    if (!turnId) {
      continue;
    }
    const key = `${thread.id}\0${turnId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ threadId: thread.id, turnId });
  }
  return result;
}

export function buildDesktopUpdateInterruptionConfirmation(
  version: string | null,
  interruptedTurnCount: number,
): string {
  const taskLabel = interruptedTurnCount === 1 ? "task" : "tasks";
  const versionLabel = version ? ` ${version}` : "";
  return `Install Synara${versionLabel} now?\n\n${interruptedTurnCount} running ${taskLabel} will be interrupted. After Synara restarts, you can continue ${interruptedTurnCount === 1 ? "it" : "them"} from the same conversations.\n\nCancel to let the ${taskLabel} finish first.`;
}

export function isDesktopUpdateContinuationApplicable(
  continuation: DesktopUpdateInterruptedTurn | null,
  threadId: ThreadId | null,
  latestTurnId: TurnId | null,
  latestTurnState: OrchestrationLatestTurnState | null,
): boolean {
  return (
    continuation !== null &&
    threadId !== null &&
    continuation.threadId === threadId &&
    latestTurnId === continuation.turnId &&
    (latestTurnState === "interrupted" || latestTurnState === "error")
  );
}

function continuationForThread(
  state: DesktopUpdateState,
  threadId: ThreadId,
): DesktopUpdateInterruptedTurn | null {
  return (
    (state.resumableInterruptedTurns ?? []).find((turn) => turn.threadId === threadId) ?? null
  );
}

export function useDesktopUpdateContinuation(
  threadId: ThreadId,
): DesktopUpdateInterruptedTurn | null {
  const [continuation, setContinuation] = useState<DesktopUpdateInterruptedTurn | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      setContinuation(null);
      return;
    }
    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const update = (state: DesktopUpdateState) => {
      if (!disposed) {
        setContinuation(continuationForThread(state, threadId));
      }
    };
    const unsubscribe = bridge.onUpdateState((state) => {
      receivedSubscriptionUpdate = true;
      update(state);
    });
    void bridge
      .getUpdateState()
      .then((state) => {
        if (!receivedSubscriptionUpdate) {
          update(state);
        }
      })
      .catch((error) => {
        console.warn("[desktop-updater] Could not read update continuation state.", error);
      });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [threadId]);

  return continuation;
}
