// FILE: repoDiffScopeStore.ts
// Purpose: Persists the active repo diff scope shared by the diff panel and header badge.
// Layer: Web UI state store
// Exports: repo diff scope labels, validation, and a persisted Zustand store.

import type { GitReadWorkingTreeDiffInput, VcsBackend } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type RepoDiffScope = NonNullable<GitReadWorkingTreeDiffInput["scope"]>;

export const DEFAULT_REPO_DIFF_SCOPE: RepoDiffScope = "workingTree";

export const REPO_DIFF_SCOPE_LABELS: Record<RepoDiffScope, string> = {
  workingTree: "Working copy",
  unstaged: "Unstaged",
  staged: "Staged",
  branch: "Branch",
};

export function resolveRepoDiffScopeLabel(
  scope: RepoDiffScope,
  backend: VcsBackend | null | undefined,
): string {
  if (scope === "branch" && backend === "jj") {
    return "Current stack";
  }
  return REPO_DIFF_SCOPE_LABELS[scope];
}

export function isRepoDiffScope(value: string): value is RepoDiffScope {
  return (
    value === "workingTree" || value === "unstaged" || value === "staged" || value === "branch"
  );
}

interface RepoDiffScopeStore {
  scope: RepoDiffScope;
  setScope: (scope: RepoDiffScope) => void;
}

const REPO_DIFF_SCOPE_STORAGE_KEY = "synara:repo-diff-scope:v1";

export const useRepoDiffScopeStore = create<RepoDiffScopeStore>()(
  persist(
    (set) => ({
      scope: DEFAULT_REPO_DIFF_SCOPE,
      setScope: (scope) => set({ scope }),
    }),
    {
      name: REPO_DIFF_SCOPE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ scope: state.scope }),
      // Validate the persisted scope on rehydrate: an unknown/legacy value would
      // otherwise flow into the diff request and the label lookup unchecked.
      merge: (persisted, current) => {
        const persistedScope = (persisted as { scope?: unknown } | undefined)?.scope;
        return {
          ...current,
          scope:
            typeof persistedScope === "string" && isRepoDiffScope(persistedScope)
              ? persistedScope
              : DEFAULT_REPO_DIFF_SCOPE,
        };
      },
    },
  ),
);
