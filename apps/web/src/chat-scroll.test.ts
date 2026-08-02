import { describe, expect, it } from "vitest";

import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  getScrollContainerDistanceFromBottom,
  isScrollContainerAtEnd,
  isScrollContainerNearBottom,
  transitionTranscriptFollowMode,
} from "./chat-scroll";

describe("transitionTranscriptFollowMode", () => {
  it("keeps layout-driven movement attached until the user scrolls away", () => {
    expect(
      transitionTranscriptFollowMode("following", {
        type: "reached-end",
        direction: null,
      }),
    ).toBe("following");
    expect(
      transitionTranscriptFollowMode("following", {
        type: "user-scroll-intent",
        direction: "away",
        isAtEnd: true,
      }),
    ).toBe("detached");
  });

  it("re-arms only after explicit movement toward the end or an arm event", () => {
    expect(
      transitionTranscriptFollowMode("following", {
        type: "user-scroll-intent",
        direction: "toward",
        isAtEnd: false,
      }),
    ).toBe("following");
    expect(
      transitionTranscriptFollowMode("detached", {
        type: "user-scroll-intent",
        direction: "toward",
        isAtEnd: false,
      }),
    ).toBe("detached");
    expect(
      transitionTranscriptFollowMode("detached", {
        type: "reached-end",
        direction: null,
      }),
    ).toBe("detached");
    expect(
      transitionTranscriptFollowMode("detached", {
        type: "reached-end",
        direction: "toward",
      }),
    ).toBe("following");
    expect(transitionTranscriptFollowMode("detached", { type: "arm" })).toBe("following");
  });
});

describe("getScrollContainerDistanceFromBottom", () => {
  it("returns the remaining distance when the viewport is above the bottom", () => {
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(80);
  });

  it("clamps negative distances and non-finite values", () => {
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: 620,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(0);
    expect(
      getScrollContainerDistanceFromBottom({
        scrollTop: Number.NaN,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(0);
  });
});
describe("isScrollContainerNearBottom", () => {
  it("returns true when already at bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 600,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns true when within the auto-scroll threshold", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 540,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });

  it("returns false when the user is meaningfully above the bottom", () => {
    expect(
      isScrollContainerNearBottom({
        scrollTop: 520,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("clamps negative thresholds to zero", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 539,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        -1,
      ),
    ).toBe(false);
  });

  it("falls back to the default threshold for non-finite values", () => {
    expect(
      isScrollContainerNearBottom(
        {
          scrollTop: 540,
          clientHeight: 400,
          scrollHeight: 1_000,
        },
        Number.NaN,
      ),
    ).toBe(true);
    expect(AUTO_SCROLL_BOTTOM_THRESHOLD_PX).toBe(64);
  });
});

describe("isScrollContainerAtEnd", () => {
  it("does not treat the broader auto-follow threshold as the physical end", () => {
    expect(
      isScrollContainerAtEnd({
        scrollTop: 540,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(false);
  });

  it("accepts sub-pixel layout rounding at the physical end", () => {
    expect(
      isScrollContainerAtEnd({
        scrollTop: 599.5,
        clientHeight: 400,
        scrollHeight: 1_000,
      }),
    ).toBe(true);
  });
});
