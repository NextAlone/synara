import { describe, expect, it } from "vitest";
import type { DesktopUpstreamUpdateState } from "@synara/contracts";

import {
  getUpstreamUpdateNotice,
  getUpstreamUpdateNoticeSignature,
  getUpstreamUpdateNoticeTooltip,
} from "./upstreamUpdate.logic";

const baseState: DesktopUpstreamUpdateState = {
  enabled: true,
  status: "idle",
  currentVersion: "0.6.3",
  availableVersion: null,
  releaseUrl: null,
  checkedAt: null,
  message: null,
};

describe("upstreamUpdate.logic", () => {
  it("shows a notice only for a release with a release-notes URL", () => {
    expect(getUpstreamUpdateNotice(baseState)).toBeNull();
    expect(
      getUpstreamUpdateNotice({
        ...baseState,
        status: "available",
        availableVersion: "v0.6.4",
        releaseUrl: "https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
      }),
    ).toEqual({
      version: "v0.6.4",
      releaseUrl: "https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
    });
  });

  it("describes an external-release action rather than an installation", () => {
    const notice = {
      version: "v0.6.4",
      releaseUrl: "https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
    };

    expect(getUpstreamUpdateNoticeTooltip(notice)).toContain("will not update Synara");
    expect(getUpstreamUpdateNoticeSignature(notice)).toBe(
      "v0.6.4:https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
    );
  });
});
