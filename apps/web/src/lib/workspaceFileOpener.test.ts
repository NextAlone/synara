import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  activateWorkspaceFile,
  resolveDockFileOpenTarget,
  resolveScratchPreviewFileOpenTarget,
  resolveWorkspaceFileOpenTarget,
} from "./workspaceFileOpener";
import { projectQueryKeys } from "./projectReactQuery";

describe("resolveWorkspaceFileOpenTarget", () => {
  it("passes workspace-relative paths through unchanged", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("README.md", null)).toBe("README.md");
  });

  it("strips :line and :line:col position suffixes", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42:7", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx:10:2", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("maps absolute paths inside the workspace to relative form", () => {
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("maps Synara public asset URLs to their workspace files", () => {
    expect(
      resolveWorkspaceFileOpenTarget("/central-icons-reversed/magnifying-glass.svg", "/repo/app"),
    ).toBe("apps/web/public/central-icons-reversed/magnifying-glass.svg");
    expect(resolveWorkspaceFileOpenTarget("/central-icons-fill/search.svg:12", "/repo/app")).toBe(
      "apps/web/public/central-icons-fill/search.svg",
    );
  });

  it("returns null for paths outside the workspace", () => {
    expect(resolveWorkspaceFileOpenTarget("/elsewhere/file.ts", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("/repo/app/file.ts", null)).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("../outside.ts", "/repo/app")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveWorkspaceFileOpenTarget("", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("   ", "/repo/app")).toBeNull();
  });
});

describe("resolveScratchPreviewFileOpenTarget", () => {
  const scratchPdf = "/private/tmp/synara-codex-workspaces/thread-1/report.pdf";

  it("returns absolute scratch-workspace preview paths unchanged", () => {
    expect(resolveScratchPreviewFileOpenTarget(scratchPdf)).toBe(scratchPdf);
    expect(
      resolveScratchPreviewFileOpenTarget("/tmp/synara-codex-workspaces/thread-1/shot.png"),
    ).toBe("/tmp/synara-codex-workspaces/thread-1/shot.png");
    expect(
      resolveScratchPreviewFileOpenTarget("/tmp/synara-codex-workspaces/thread-1/report.html"),
    ).toBe("/tmp/synara-codex-workspaces/thread-1/report.html");
  });

  it("strips :line and :line:col position suffixes", () => {
    expect(resolveScratchPreviewFileOpenTarget(`${scratchPdf}:3`)).toBe(scratchPdf);
    expect(resolveScratchPreviewFileOpenTarget(`${scratchPdf}:3:14`)).toBe(scratchPdf);
  });

  it("returns null for scratch-workspace files without an in-app binary preview", () => {
    expect(
      resolveScratchPreviewFileOpenTarget("/tmp/synara-codex-workspaces/thread-1/notes.ts"),
    ).toBeNull();
  });

  it("returns null for absolute preview paths outside a scratch workspace", () => {
    expect(resolveScratchPreviewFileOpenTarget("/Users/dev/Documents/report.pdf")).toBeNull();
  });

  it("returns null for relative paths", () => {
    expect(resolveScratchPreviewFileOpenTarget("docs/report.pdf")).toBeNull();
    expect(
      resolveScratchPreviewFileOpenTarget("synara-codex-workspaces/thread-1/a.pdf"),
    ).toBeNull();
  });
});

describe("resolveDockFileOpenTarget", () => {
  const scratchPdf = "/private/tmp/synara-codex-workspaces/thread-1/report.pdf";

  it("opens scratch preview files even when no workspace is attached", () => {
    expect(resolveDockFileOpenTarget(scratchPdf, null)).toBe(scratchPdf);
  });

  it("does not treat workspace-relative paths as previewable without a workspace", () => {
    expect(resolveDockFileOpenTarget("docs/report.pdf", null)).toBeNull();
    expect(resolveDockFileOpenTarget("src/page.tsx", null)).toBeNull();
  });

  it("keeps workspace files relative when a workspace is attached", () => {
    expect(resolveDockFileOpenTarget("/repo/app/src/page.tsx:10", "/repo/app")).toBe(
      "src/page.tsx",
    );
    expect(resolveDockFileOpenTarget("src/page.tsx", "/repo/app")).toBe("src/page.tsx");
  });

  it("opens absolute local paths directly instead of falling back to the editor", () => {
    expect(resolveDockFileOpenTarget("/Users/dev/Downloads/report.txt:4", "/repo/app")).toBe(
      "/Users/dev/Downloads/report.txt",
    );
  });
});

describe("activateWorkspaceFile", () => {
  it("reveals unsupported binary files without selecting the in-app preview", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(projectQueryKeys.readFile("/repo/app", "app.apk"), {
      kind: "unsupported-binary",
      relativePath: "build/app.apk",
    });
    const preview = vi.fn();
    const reveal = vi.fn().mockResolvedValue(undefined);

    const disposition = await activateWorkspaceFile({
      queryClient,
      workspaceRoot: "/repo/app",
      filePath: "app.apk",
      preview,
      reveal,
    });

    expect(disposition).toEqual({
      kind: "reveal",
      relativePath: "build/app.apk",
    });
    expect(reveal).toHaveBeenCalledWith("/repo/app/build/app.apk");
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps supported binary previews inside the app", async () => {
    const preview = vi.fn();
    const reveal = vi.fn().mockResolvedValue(undefined);

    const disposition = await activateWorkspaceFile({
      queryClient: new QueryClient(),
      workspaceRoot: "/repo/app",
      filePath: "assets/screenshot.png",
      preview,
      reveal,
    });

    expect(disposition).toEqual({ kind: "preview" });
    expect(preview).toHaveBeenCalledOnce();
    expect(reveal).not.toHaveBeenCalled();
  });

  it("reveals unsupported absolute local binaries without opening the dock preview", async () => {
    const queryClient = new QueryClient();
    const filePath = "/Users/dev/Downloads/credentials.age";
    queryClient.setQueryData(projectQueryKeys.localPreviewGrant(filePath), {
      grant: "grant-token",
      expiresAt: "2999-01-01T00:00:00.000Z",
    });
    queryClient.setQueryData(projectQueryKeys.readFile(null, filePath), {
      kind: "unsupported-binary",
      relativePath: filePath,
    });
    const preview = vi.fn();
    const reveal = vi.fn().mockResolvedValue(undefined);

    const disposition = await activateWorkspaceFile({
      queryClient,
      workspaceRoot: null,
      filePath,
      preview,
      reveal,
    });

    expect(disposition).toEqual({
      kind: "reveal",
      relativePath: filePath,
    });
    expect(reveal).toHaveBeenCalledWith(filePath);
    expect(preview).not.toHaveBeenCalled();
  });
});
