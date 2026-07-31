import { describe, expect, it } from "vitest";

import {
  normalizeJjWorkspaceBase,
  resolveDraftThreadBranchForEnvironmentMode,
} from "./jjWorkspaceBase";

describe("normalizeJjWorkspaceBase", () => {
  it("trims valid bases and rejects empty or malformed values", () => {
    expect(normalizeJjWorkspaceBase(" feature/reuse-base ")).toBe("feature/reuse-base");
    expect(normalizeJjWorkspaceBase("   ")).toBeNull();
    expect(normalizeJjWorkspaceBase(42)).toBeNull();
  });
});

describe("resolveDraftThreadBranchForEnvironmentMode", () => {
  it("reuses the remembered project base for a new JJ workspace", () => {
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "worktree",
        vcsBackend: "jj",
        activeThreadBranch: null,
        draftThreadBranch: null,
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: "feature/reuse-base",
      }),
    ).toBe("feature/reuse-base");
  });

  it("keeps explicit thread and draft bases ahead of the remembered base", () => {
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "worktree",
        vcsBackend: "jj",
        activeThreadBranch: "feature/thread-base",
        draftThreadBranch: "feature/draft-base",
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: "feature/reuse-base",
      }),
    ).toBe("feature/thread-base");
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "worktree",
        vcsBackend: "jj",
        activeThreadBranch: null,
        draftThreadBranch: "feature/draft-base",
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: "feature/reuse-base",
      }),
    ).toBe("feature/draft-base");
  });

  it("falls back to @ for JJ and preserves Git branch resolution", () => {
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "worktree",
        vcsBackend: "jj",
        activeThreadBranch: null,
        draftThreadBranch: null,
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: null,
      }),
    ).toBe("@");
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "worktree",
        vcsBackend: "git",
        activeThreadBranch: null,
        draftThreadBranch: null,
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: "feature/ignored",
      }),
    ).toBe("main");
  });

  it("keeps local JJ branchless", () => {
    expect(
      resolveDraftThreadBranchForEnvironmentMode({
        mode: "local",
        vcsBackend: "jj",
        activeThreadBranch: "feature/ignored",
        draftThreadBranch: "feature/ignored",
        activeRootBranch: "main",
        lastSelectedJjWorkspaceBase: "feature/ignored",
      }),
    ).toBeNull();
  });
});
