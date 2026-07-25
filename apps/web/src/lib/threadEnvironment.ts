// FILE: threadEnvironment.ts
// Purpose: Shared helpers for deriving thread environment intent and fork targets.
// Layer: Web domain helpers
// Exports: thread env resolution + `/fork` target planning

import type { ThreadEnvironmentMode, VcsBackend } from "@synara/contracts";
import {
  isPendingThreadWorktree,
  resolveThreadEnvironmentMode,
  resolveThreadWorkspaceCwd,
  resolveThreadWorkspaceState,
  type ResolvedThreadWorkspaceState,
} from "@synara/shared/threadEnvironment";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import type { Thread } from "../types";

export type ForkThreadTarget = "local" | "worktree";

/**
 * User-facing noun for an isolated thread environment.
 * Git worktrees vs JJ workspaces — protocol still uses envMode "worktree".
 */
export type IsolatedWorkspaceNoun = "worktree" | "workspace";

export function resolveIsolatedWorkspaceNoun(
  backend?: VcsBackend | null | undefined,
): IsolatedWorkspaceNoun {
  return backend === "jj" ? "workspace" : "worktree";
}

export function formatIsolatedWorkspaceNoun(
  backend: VcsBackend | null | undefined,
): "Worktree" | "Workspace" {
  return backend === "jj" ? "Workspace" : "Worktree";
}

export interface ResolvedForkThreadEnvironment {
  target: ForkThreadTarget;
  envMode: ThreadEnvironmentMode;
  branch: string | null;
  worktreePath: string | null;
  associatedWorktreePath: string | null;
  associatedWorktreeBranch: string | null;
  associatedWorktreeRef: string | null;
}

export {
  isPendingThreadWorktree,
  resolveThreadEnvironmentMode,
  resolveThreadWorkspaceState,
} from "@synara/shared/threadEnvironment";

export interface ThreadEnvironmentPresentation {
  mode: ThreadEnvironmentMode;
  workspaceState: ResolvedThreadWorkspaceState;
  /** Lowercase product noun for isolated environments (`worktree` or `workspace`). */
  isolatedNoun: IsolatedWorkspaceNoun;
  shortLabel: "Local" | "Worktree" | "Workspace";
  localOptionLabel: "Local project";
  worktreeOptionLabel: "Worktree" | "Workspace";
  newIsolatedOptionLabel: "New worktree" | "New workspace";
  handOffToIsolatedLabel: "Hand off to new worktree" | "Hand off to new workspace";
  worktreeBadgeLabel: "Worktree" | "Worktree pending" | "Workspace" | "Workspace pending" | null;
}

export function resolveThreadEnvironmentPresentation(input: {
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
  backend?: VcsBackend | null | undefined;
}): ThreadEnvironmentPresentation {
  const mode = resolveThreadEnvironmentMode(input);
  const workspaceState = resolveThreadWorkspaceState(input);
  const isolatedNoun = resolveIsolatedWorkspaceNoun(input.backend);
  const isolatedLabel = formatIsolatedWorkspaceNoun(input.backend);
  const pendingLabel = isolatedNoun === "workspace" ? "Workspace pending" : "Worktree pending";

  return {
    mode,
    workspaceState,
    isolatedNoun,
    shortLabel: mode === "worktree" ? isolatedLabel : "Local",
    localOptionLabel: "Local project",
    worktreeOptionLabel: isolatedLabel,
    newIsolatedOptionLabel: isolatedNoun === "workspace" ? "New workspace" : "New worktree",
    handOffToIsolatedLabel:
      isolatedNoun === "workspace" ? "Hand off to new workspace" : "Hand off to new worktree",
    worktreeBadgeLabel:
      workspaceState === "worktree-ready"
        ? isolatedLabel
        : workspaceState === "worktree-pending"
          ? pendingLabel
          : null,
  };
}

export interface DiffEnvironmentState {
  pending: boolean;
  cwd: string | null;
  disabledReason: string | null;
}

// Diff surfaces stay disabled while a worktree-intended chat is still waiting for its path.
export function resolveDiffEnvironmentState(input: {
  projectCwd?: string | null | undefined;
  envMode?: ThreadEnvironmentMode | null | undefined;
  worktreePath?: string | null | undefined;
  workingDirectory?: string | null | undefined;
  backend?: VcsBackend | null | undefined;
}): DiffEnvironmentState {
  const pending = isPendingThreadWorktree(input);
  const isolatedNoun = resolveIsolatedWorkspaceNoun(input.backend);
  return {
    pending,
    cwd: pending
      ? null
      : resolveThreadWorkspaceCwd({
          projectCwd: input.projectCwd,
          envMode: input.envMode,
          worktreePath: input.worktreePath,
          workingDirectory: input.workingDirectory,
        }),
    disabledReason: pending
      ? `Diff and summary will be available once the ${isolatedNoun} is ready for this chat.`
      : null,
  };
}

// Fork planning keeps "local" attached to the current local checkout. For worktree-backed
// threads that means reusing the existing worktree, while "worktree" always plans a new one.
export function resolveForkThreadEnvironment(input: {
  target: ForkThreadTarget;
  activeRootBranch: string | null;
  sourceThread: Pick<
    Thread,
    | "branch"
    | "envMode"
    | "worktreePath"
    | "associatedWorktreePath"
    | "associatedWorktreeBranch"
    | "associatedWorktreeRef"
  >;
}): ResolvedForkThreadEnvironment {
  const sourceEnvMode = resolveThreadEnvironmentMode({
    envMode: input.sourceThread.envMode,
    worktreePath: input.sourceThread.worktreePath,
  });
  const sourceBranch = input.sourceThread.branch ?? input.activeRootBranch;
  const sourceWorktreePath = input.sourceThread.worktreePath ?? null;
  const sourceAssociatedWorktreePath =
    input.sourceThread.associatedWorktreePath ?? sourceWorktreePath;
  const sourceAssociatedWorktreeBranch =
    input.sourceThread.associatedWorktreeBranch ?? sourceBranch;
  const sourceAssociatedWorktreeRef =
    input.sourceThread.associatedWorktreeRef ?? sourceAssociatedWorktreeBranch;

  if (input.target === "worktree") {
    const associatedWorktree = deriveAssociatedWorktreeMetadata({
      associatedWorktreePath: null,
      associatedWorktreeBranch: sourceBranch,
      associatedWorktreeRef: sourceAssociatedWorktreeRef ?? sourceBranch,
    });
    return {
      target: "worktree",
      envMode: "worktree",
      branch: sourceBranch,
      worktreePath: null,
      ...associatedWorktree,
    };
  }

  // Codex-style "Fork Into Local" stays in the current local checkout, which for a
  // worktree-backed thread means reusing that worktree rather than bouncing to root.
  if (sourceEnvMode === "worktree" && sourceWorktreePath) {
    const associatedWorktree = deriveAssociatedWorktreeMetadata({
      branch: sourceBranch,
      worktreePath: sourceWorktreePath,
      associatedWorktreePath: sourceAssociatedWorktreePath,
      associatedWorktreeBranch: sourceAssociatedWorktreeBranch,
      associatedWorktreeRef: sourceAssociatedWorktreeRef,
    });
    return {
      target: "local",
      envMode: "worktree",
      branch: sourceBranch,
      worktreePath: sourceWorktreePath,
      ...associatedWorktree,
    };
  }

  const associatedWorktree = deriveAssociatedWorktreeMetadata({
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
  });
  return {
    target: "local",
    envMode: "local",
    branch: sourceBranch,
    worktreePath: null,
    ...associatedWorktree,
  };
}
