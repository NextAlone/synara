// FILE: turnDiffAvailability.ts
// Purpose: Shared availability rules for checkpoint-backed turn review surfaces.
// Layer: Web UI domain logic

import type { TurnDiffSummary } from "./types";

export type TurnDiffAvailability = "ready" | "pending" | "unavailable";

function isProviderDiffPlaceholder(summary: Pick<TurnDiffSummary, "checkpointRef">): boolean {
  return summary.checkpointRef?.startsWith("provider-diff:") === true;
}

export function resolveTurnDiffAvailability(
  summary: Pick<TurnDiffSummary, "checkpointRef" | "status">,
): TurnDiffAvailability {
  if (isProviderDiffPlaceholder(summary)) {
    return "pending";
  }
  if (summary.status === "missing" || summary.status === "error") {
    return "unavailable";
  }
  return "ready";
}

export function isTurnDiffSummaryReviewable(
  summary: Pick<TurnDiffSummary, "checkpointRef" | "status">,
): boolean {
  return resolveTurnDiffAvailability(summary) === "ready";
}

export function resolveTurnDiffMenuStatus(
  summary: Pick<TurnDiffSummary, "checkpointRef" | "files" | "status">,
): string | null {
  const availability = resolveTurnDiffAvailability(summary);
  if (availability === "pending") {
    return "Preparing";
  }
  if (availability === "unavailable") {
    return "Unavailable";
  }
  return summary.files.length === 0 ? "No changes" : null;
}

export function resolveTurnDiffCacheScope(
  summary: Pick<TurnDiffSummary, "checkpointRef" | "status" | "turnId">,
): string {
  return [
    "turn",
    summary.turnId,
    summary.status ?? "legacy",
    summary.checkpointRef ?? "no-checkpoint-ref",
  ].join(":");
}
