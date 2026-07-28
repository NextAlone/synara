// FILE: upstreamUpdate.logic.ts
// Purpose: Maps metadata-only upstream releases to a UI notice with no install action.
// Layer: Web UI state helper

import type { DesktopUpstreamUpdateState } from "@synara/contracts";

export interface UpstreamUpdateNotice {
  readonly version: string;
  readonly releaseUrl: string;
}

export function getUpstreamUpdateNotice(
  state: DesktopUpstreamUpdateState | null,
): UpstreamUpdateNotice | null {
  if (
    !state?.enabled ||
    state.status !== "available" ||
    !state.availableVersion ||
    !state.releaseUrl
  ) {
    return null;
  }
  return {
    version: state.availableVersion,
    releaseUrl: state.releaseUrl,
  };
}

export function getUpstreamUpdateNoticeTooltip(notice: UpstreamUpdateNotice): string {
  return `Upstream ${notice.version} is available. View release notes only; this will not update Synara.`;
}

export function getUpstreamUpdateNoticeSignature(notice: UpstreamUpdateNotice): string {
  return `${notice.version}:${notice.releaseUrl}`;
}
