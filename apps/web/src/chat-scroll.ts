export const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 64;
export const SCROLL_END_EPSILON_PX = 1;

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
