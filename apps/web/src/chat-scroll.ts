export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
export const SCROLL_END_EPSILON_PX = 1;
export const TRANSCRIPT_BOTTOM_CLEARANCE_PX = 64;

export type TranscriptFollowMode = "following" | "detached";
export type TranscriptScrollDirection = "away" | "toward";

export type TranscriptFollowEvent =
  | { type: "arm" }
  | {
      type: "user-scroll-intent";
      direction: TranscriptScrollDirection;
      isAtEnd: boolean;
    }
  | {
      type: "reached-end";
      direction: TranscriptScrollDirection | null;
    };

/**
 * Codex keeps follow intent separate from the current scroll geometry. A layout
 * change can temporarily move the viewport away from the bottom, but only real
 * user input is allowed to detach the transcript from live turn growth.
 */
export function transitionTranscriptFollowMode(
  current: TranscriptFollowMode,
  event: TranscriptFollowEvent,
): TranscriptFollowMode {
  switch (event.type) {
    case "arm":
      return "following";
    case "user-scroll-intent":
      if (event.direction === "away") return "detached";
      return current === "following" || event.isAtEnd ? "following" : "detached";
    case "reached-end":
      return current === "following" || event.direction === "toward" ? "following" : "detached";
  }
}

interface ScrollPosition {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export function getScrollContainerDistanceFromBottom(position: ScrollPosition): number {
  const { scrollTop, clientHeight, scrollHeight } = position;
  if (![scrollTop, clientHeight, scrollHeight].every(Number.isFinite)) {
    return 0;
  }

  return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

export function isScrollContainerNearBottom(
  position: ScrollPosition,
  thresholdPx = AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
): boolean {
  const threshold = Number.isFinite(thresholdPx)
    ? Math.max(0, thresholdPx)
    : AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

  return getScrollContainerDistanceFromBottom(position) <= threshold;
}

/**
 * Unlike the auto-follow threshold, this is for visual tail geometry: a tail
 * that has not reached the physical end can still sit behind the composer.
 */
export function isScrollContainerAtEnd(
  position: ScrollPosition,
  epsilonPx = SCROLL_END_EPSILON_PX,
): boolean {
  const epsilon = Number.isFinite(epsilonPx)
    ? Math.max(0, epsilonPx)
    : SCROLL_END_EPSILON_PX;

  return getScrollContainerDistanceFromBottom(position) <= epsilon;
}
