// FILE: jjWorkspaceBase.ts
// Purpose: Resolves the project-scoped JJ base used when creating a new workspace.
// Layer: Web workspace domain helper

import type { ThreadEnvironmentMode, VcsBackend } from "@synara/contracts";

export function normalizeJjWorkspaceBase(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveDraftThreadBranchForEnvironmentMode(input: {
  mode: ThreadEnvironmentMode;
  vcsBackend: VcsBackend | null | undefined;
  activeThreadBranch: string | null | undefined;
  draftThreadBranch: string | null | undefined;
  activeRootBranch: string | null | undefined;
  lastSelectedJjWorkspaceBase: string | null | undefined;
}): string | null {
  if (input.mode === "worktree") {
    if (input.vcsBackend === "jj") {
      return (
        input.activeThreadBranch ??
        input.draftThreadBranch ??
        normalizeJjWorkspaceBase(input.lastSelectedJjWorkspaceBase) ??
        "@"
      );
    }
    return input.activeThreadBranch ?? input.draftThreadBranch ?? input.activeRootBranch ?? null;
  }
  if (input.vcsBackend === "jj") {
    return null;
  }
  return input.activeThreadBranch ?? input.draftThreadBranch ?? null;
}
