import type { GitBranch } from "@synara/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  type AssociatedWorktreeMetadata,
} from "@synara/shared/threadWorkspace";
import { Schema } from "effect";
import type { ThreadWorkspacePatch } from "../types";

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

/** Synthetic JJ bases offered only when creating a new workspace (not for Local). */
export const JJ_WORKTREE_BASE_CURRENT = "@";
export const JJ_WORKTREE_BASE_PARENT = "@-";

export type VcsToolbarBackend = "git" | "jj";

export function isJjSyntheticWorktreeBaseRef(ref: string): boolean {
  return ref === JJ_WORKTREE_BASE_CURRENT || ref === JJ_WORKTREE_BASE_PARENT;
}

/**
 * JJ Local always follows the default workspace working copy (`@`).
 * Bookmark / `@` / `@-` selection is only meaningful when creating a worktree.
 */
export function isJjLocalDefaultWorkspaceMode(input: {
  backend: VcsToolbarBackend | null | undefined;
  envMode: EnvMode;
  activeWorktreePath: string | null;
}): boolean {
  return input.backend === "jj" && input.envMode === "local" && input.activeWorktreePath === null;
}

export function resolveDefaultWorktreeBaseRef(input: {
  backend: VcsToolbarBackend | null | undefined;
  currentReference: string | null;
}): string | null {
  if (input.backend === "jj") {
    return JJ_WORKTREE_BASE_CURRENT;
  }
  return input.currentReference;
}

export function getJjWorktreeBaseSpecialItems(): ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description: string;
}> {
  return [
    {
      value: JJ_WORKTREE_BASE_CURRENT,
      label: "Current change (@)",
      description: "Default workspace working copy",
    },
    {
      value: JJ_WORKTREE_BASE_PARENT,
      label: "Parent change (@-)",
      description: "Parent of the current change",
    },
  ] as const;
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
  serverThreadEnvMode?: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode, serverThreadEnvMode } = input;
  return activeWorktreePath ||
    serverThreadEnvMode === "worktree" ||
    (!hasServerThread && draftThreadEnvMode === "worktree")
    ? "worktree"
    : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

/**
 * Studio threads use a concrete working directory as their entire workspace.
 * Branch-selector patches still speak in project/worktree terms, so normalize
 * them at this boundary instead of leaking worktree metadata into the thread.
 */
export function resolveFixedLocalWorkspacePatch(input: {
  currentWorkingDirectory: string | null;
  patch: ThreadWorkspacePatch;
}): ThreadWorkspacePatch {
  const workingDirectory =
    input.patch.workingDirectory !== undefined
      ? input.patch.workingDirectory
      : (input.patch.worktreePath ?? input.currentWorkingDirectory);

  return {
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
  };
}

export function resolveBranchToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
  preferActiveThreadBranch?: boolean;
  /** When true, Local JJ always displays `@` (default workspace working copy). */
  jjLocalDefaultWorkspace?: boolean;
}): string | null {
  const {
    envMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
    preferActiveThreadBranch = false,
    jjLocalDefaultWorkspace = false,
  } = input;
  if (jjLocalDefaultWorkspace) {
    return JJ_WORKTREE_BASE_CURRENT;
  }
  if (preferActiveThreadBranch && activeThreadBranch !== null) {
    return activeThreadBranch;
  }
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadBranch ?? currentGitBranch;
  }
  return currentGitBranch ?? activeThreadBranch;
}

// Local Git threads should mirror the concrete checkout; stale thread metadata makes
// the current Git branch appear selectable while clicks only perform a no-op.
// Local JJ never syncs a bookmark: it always follows the default workspace `@`.
export function shouldSyncLocalThreadBranch(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
  hasServerThread: boolean;
  isBranchActionPending: boolean;
  preferActiveThreadBranch?: boolean;
  jjLocalDefaultWorkspace?: boolean;
}): boolean {
  if (input.jjLocalDefaultWorkspace) {
    return false;
  }
  return (
    input.envMode === "local" &&
    input.activeWorktreePath === null &&
    !input.isBranchActionPending &&
    !(input.preferActiveThreadBranch && input.activeThreadBranch !== null) &&
    input.currentGitBranch !== null &&
    (input.hasServerThread || input.activeThreadBranch !== null) &&
    input.activeThreadBranch !== input.currentGitBranch
  );
}

// Branch-only local updates should keep the paired worktree metadata intact.
export function resolveAssociatedWorktreeMetadataAfterWorkspacePatch(input: {
  branch: string | null;
  worktreePath: string | null;
  existingAssociatedWorktreePath: string | null;
  existingAssociatedWorktreeBranch: string | null;
  existingAssociatedWorktreeRef: string | null;
  patchAssociatedWorktreePath?: string | null;
  patchAssociatedWorktreeBranch?: string | null;
  patchAssociatedWorktreeRef?: string | null;
}): AssociatedWorktreeMetadata {
  const shouldPreserveExistingAssociation =
    !input.worktreePath && input.patchAssociatedWorktreePath === undefined;

  return deriveAssociatedWorktreeMetadata({
    branch: input.branch,
    worktreePath: input.worktreePath,
    ...(input.patchAssociatedWorktreePath !== undefined
      ? { associatedWorktreePath: input.patchAssociatedWorktreePath }
      : shouldPreserveExistingAssociation
        ? { associatedWorktreePath: input.existingAssociatedWorktreePath }
        : {}),
    ...(input.patchAssociatedWorktreeBranch !== undefined
      ? { associatedWorktreeBranch: input.patchAssociatedWorktreeBranch }
      : shouldPreserveExistingAssociation
        ? { associatedWorktreeBranch: input.existingAssociatedWorktreeBranch }
        : {}),
    ...(input.patchAssociatedWorktreeRef !== undefined
      ? { associatedWorktreeRef: input.patchAssociatedWorktreeRef }
      : input.patchAssociatedWorktreeBranch === undefined && shouldPreserveExistingAssociation
        ? { associatedWorktreeRef: input.existingAssociatedWorktreeRef }
        : {}),
  });
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string {
  const firstSeparatorIndex = branchName.indexOf("/");
  if (firstSeparatorIndex <= 0 || firstSeparatorIndex === branchName.length - 1) {
    return branchName;
  }
  return branchName.slice(firstSeparatorIndex + 1);
}

function deriveLocalBranchNameCandidatesFromRemoteRef(
  branchName: string,
  remoteName?: string,
): ReadonlyArray<string> {
  const candidates = new Set<string>();
  const firstSlashCandidate = deriveLocalBranchNameFromRemoteRef(branchName);
  if (firstSlashCandidate.length > 0) {
    candidates.add(firstSlashCandidate);
  }

  if (remoteName) {
    const remotePrefix = `${remoteName}/`;
    if (branchName.startsWith(remotePrefix) && branchName.length > remotePrefix.length) {
      candidates.add(branchName.slice(remotePrefix.length));
    }
    const remoteSuffix = `@${remoteName}`;
    if (branchName.endsWith(remoteSuffix) && branchName.length > remoteSuffix.length) {
      candidates.add(branchName.slice(0, -remoteSuffix.length));
    }
  }

  return [...candidates];
}

export function dedupeRemoteBranchesWithLocalMatches(
  branches: ReadonlyArray<GitBranch>,
): ReadonlyArray<GitBranch> {
  const localBranchNames = new Set(
    branches.filter((branch) => !branch.isRemote).map((branch) => branch.name),
  );

  return branches.filter((branch) => {
    if (!branch.isRemote) {
      return true;
    }

    if (branch.remoteName !== "origin") {
      return true;
    }

    const localBranchCandidates = deriveLocalBranchNameCandidatesFromRemoteRef(
      branch.name,
      branch.remoteName,
    );
    return !localBranchCandidates.some((candidate) => localBranchNames.has(candidate));
  });
}

export function resolveBranchSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  branch: Pick<GitBranch, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, branch } = input;

  if (branch.worktreePath) {
    return {
      checkoutCwd: branch.worktreePath,
      nextWorktreePath: branch.worktreePath === activeProjectCwd ? null : branch.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath =
    activeWorktreePath !== null && branch.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}
