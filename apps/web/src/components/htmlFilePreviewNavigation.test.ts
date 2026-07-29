// FILE: htmlFilePreviewNavigation.test.ts
// Purpose: Guards report-return state after a sandboxed HTML iframe follows a resource link.

import { describe, expect, it } from "vitest";

import {
  createHtmlFilePreviewNavigationState,
  reduceHtmlFilePreviewNavigation,
} from "./htmlFilePreviewNavigation";

describe("HTML file preview navigation", () => {
  it("shows a report return action only after the frame leaves its initial document", () => {
    let state = createHtmlFilePreviewNavigationState();

    state = reduceHtmlFilePreviewNavigation(state, { type: "frame-loaded" });
    expect(state).toMatchObject({
      frameKey: 0,
      hasLoadedReport: true,
      canReturnToReport: false,
    });

    state = reduceHtmlFilePreviewNavigation(state, { type: "frame-loaded" });
    expect(state.canReturnToReport).toBe(true);
  });

  it("remounts the original report frame when returning from a linked resource", () => {
    let state = createHtmlFilePreviewNavigationState();
    state = reduceHtmlFilePreviewNavigation(state, { type: "frame-loaded" });
    state = reduceHtmlFilePreviewNavigation(state, { type: "frame-loaded" });

    state = reduceHtmlFilePreviewNavigation(state, { type: "return-to-report" });

    expect(state).toEqual({
      frameKey: 1,
      hasLoadedReport: false,
      canReturnToReport: false,
    });
  });
});
