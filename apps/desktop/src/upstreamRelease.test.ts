import { describe, expect, it, vi } from "vitest";

import {
  SYNARA_UPSTREAM_RELEASE_API_URL,
  buildUpstreamReleasePageUrl,
  fetchLatestUpstreamRelease,
  isUpstreamReleaseNewer,
  isSynaraUpstreamReleaseRepository,
  parseUpstreamRelease,
} from "./upstreamRelease";

describe("upstreamRelease", () => {
  it("reads upstream release metadata without exposing an installer payload", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ tag_name: "v0.6.4", html_url: "https://untrusted.example/file.zip" })),
    );

    const release = await fetchLatestUpstreamRelease({ fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledWith(
      SYNARA_UPSTREAM_RELEASE_API_URL,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
      }),
    );
    expect(release).toEqual({
      version: "v0.6.4",
      releaseUrl: "https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
    });
    expect(release).not.toHaveProperty("downloadUrl");
  });

  it("derives a fixed GitHub release page instead of trusting response links", () => {
    expect(
      parseUpstreamRelease({ tag_name: "release/0.6.4", html_url: "https://untrusted.example" }),
    ).toEqual({
      version: "release/0.6.4",
      releaseUrl: "https://github.com/Emanuele-web04/synara/releases/tag/release%2F0.6.4",
    });
    expect(buildUpstreamReleasePageUrl("v0.6.4")).toBe(
      "https://github.com/Emanuele-web04/synara/releases/tag/v0.6.4",
    );
  });

  it("rejects malformed release metadata and failed upstream checks", async () => {
    expect(() => parseUpstreamRelease({ tag_name: "  " })).toThrow("missing tag_name");

    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response("rate limited", { status: 429 }),
    );
    await expect(fetchLatestUpstreamRelease({ fetch: fetchMock })).rejects.toThrow("HTTP 429");
  });

  it("uses version comparison only to decide whether to show a notice", () => {
    const release = parseUpstreamRelease({ tag_name: "v0.6.4" });
    expect(isUpstreamReleaseNewer("0.6.3", release)).toBe(true);
    expect(isUpstreamReleaseNewer("0.6.4", release)).toBe(false);
  });

  it("recognizes the fixed upstream repository regardless of GitHub slug casing", () => {
    expect(isSynaraUpstreamReleaseRepository("Emanuele-web04/Synara")).toBe(true);
    expect(isSynaraUpstreamReleaseRepository("NextAlone/synara")).toBe(false);
  });
});
