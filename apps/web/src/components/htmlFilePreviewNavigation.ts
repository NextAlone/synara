// FILE: htmlFilePreviewNavigation.ts
// Purpose: Keeps a sandboxed HTML report iframe returnable after it follows a link.
// Layer: Web file-preview state
// Exports: HTML preview iframe navigation reducer

export interface HtmlFilePreviewNavigationState {
  /** Recreates the iframe when returning to the report so its URL is reloaded. */
  frameKey: number;
  /** The first iframe load is the report itself; later loads are linked resources. */
  hasLoadedReport: boolean;
  /** Whether the iframe can be restored to its original HTML report. */
  canReturnToReport: boolean;
}

export type HtmlFilePreviewNavigationAction =
  | { type: "frame-loaded" }
  | { type: "return-to-report" };

export function createHtmlFilePreviewNavigationState(): HtmlFilePreviewNavigationState {
  return {
    frameKey: 0,
    hasLoadedReport: false,
    canReturnToReport: false,
  };
}

/**
 * The HTML preview frame is sandboxed, so the parent cannot inspect its current
 * location. The first completed load is the report; a later top-level load means
 * the report followed a resource link. Returning remounts the frame at its
 * original `src`, rather than attempting cross-origin history access.
 */
export function reduceHtmlFilePreviewNavigation(
  state: HtmlFilePreviewNavigationState,
  action: HtmlFilePreviewNavigationAction,
): HtmlFilePreviewNavigationState {
  if (action.type === "frame-loaded") {
    if (!state.hasLoadedReport) {
      return { ...state, hasLoadedReport: true };
    }
    return state.canReturnToReport ? state : { ...state, canReturnToReport: true };
  }

  return {
    frameKey: state.frameKey + 1,
    hasLoadedReport: false,
    canReturnToReport: false,
  };
}
