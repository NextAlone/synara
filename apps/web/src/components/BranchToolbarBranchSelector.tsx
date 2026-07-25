// Purpose: Branch/worktree picker for the chat toolbar.
// Coordinates reference switch/create actions and decorates rows with VCS metadata.
// Depends on: project-scoped VCS queries, native API mutations, and toolbar selection rules.
// Note: the "Create branch" footer row uses raw <button> because it is a
// menu-item-style affordance inside a ComboboxPopup, not a generic action.
import type {
  GitBranch,
  GitStashInfoResult,
  NativeApi,
  ProjectId,
  ProjectKind,
  ProjectVcsState,
  ThreadId,
  VcsBackend,
  VcsStatusResult,
} from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDownIcon, PlusIcon } from "~/lib/icons";
import { CentralIcon } from "~/lib/central-icons";
import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { invalidateGitQueries } from "../lib/gitReactQuery";
import {
  invalidateVcsQueries,
  makeVcsQueryTarget,
  vcsQueryKeys,
  vcsReferencesQueryOptions,
  vcsStatusQueryOptions,
} from "../lib/vcsReactQuery";
import { readNativeApi } from "../nativeApi";
import { parsePullRequestReference } from "../pullRequestReference";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  EnvMode,
  getJjChangeDistancePresentation,
  getJjWorktreeBaseSpecialItems,
  isJjLocalDefaultWorkspaceMode,
  resolveBranchSelectionTarget,
  resolveBranchToolbarValue,
  resolveDefaultWorktreeBaseRef,
  shouldShowJjChangeDistance,
  shouldSyncLocalThreadBranch,
} from "./BranchToolbar.logic";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./chat/environment/EnvironmentRow";
import { COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME } from "./chat/composerPickerStyles";
import type { ThreadWorkspacePatch } from "../types";

/**
 * Where the selector is rendered. `toolbar` keeps the compact composer-footer pill;
 * `panel` makes the trigger a full-width Environment panel row and drops its menu
 * downward instead of upward.
 */
export type BranchSelectorVariant = "toolbar" | "panel";

interface BranchToolbarBranchSelectorProps {
  projectId: ProjectId;
  projectKind: ProjectKind;
  projectVcs: ProjectVcsState;
  vcsBackend: VcsBackend;
  activeThreadId: ThreadId | null;
  activeProjectCwd: string;
  activeThreadBranch: string | null;
  activeWorktreePath: string | null;
  branchCwd: string | null;
  threadWorkingDirectory: string | null;
  effectiveEnvMode: EnvMode;
  envLocked: boolean;
  hasServerThread: boolean;
  onSetThreadWorkspace: (patch: ThreadWorkspacePatch) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
  variant?: BranchSelectorVariant;
}

type StashDiscardDialogState = {
  cwd: string;
  error: string | null;
  info: GitStashInfoResult | null;
  loading: boolean;
};

function toBranchActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

const DIRTY_WORKTREE_ERROR_PATTERN =
  /Uncommitted changes block checkout to ([^:\n]+):\s*\n((?:\s*-\s*.+(?:\n|$))+)/;
const STASH_CONFLICT_PATTERN = /Stash could not be applied|Stash applied with merge conflicts/;
const UNRESOLVED_INDEX_PATTERN = /you need to resolve your current index/i;
const GIT_INDEX_LOCK_PATTERN =
  /(?:Unable to create '([^']*\.git\/index\.lock)'|Another git process seems to be running|\.git\/index\.lock.*File exists)/i;
const GIT_INDEX_WRITE_PATTERN = /could not write index/i;
let activeBranchRecoveryToastId: ReturnType<typeof toastManager.add> | null = null;

function closeActiveBranchRecoveryToast(): void {
  if (!activeBranchRecoveryToastId) return;
  toastManager.close(activeBranchRecoveryToastId);
  activeBranchRecoveryToastId = null;
}

function addBranchRecoveryToast(input: Parameters<typeof toastManager.add>[0]) {
  closeActiveBranchRecoveryToast();
  activeBranchRecoveryToastId = toastManager.add(input);
  return activeBranchRecoveryToastId;
}

function parseDirtyWorktreeError(error: unknown): { branch: string; files: string[] } | null {
  const detail = error instanceof Error ? error.message : String(error);
  const match = DIRTY_WORKTREE_ERROR_PATTERN.exec(detail);
  if (!match?.[1] || !match[2]) return null;
  const files = match[2]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter((line) => line.length > 0);
  if (files.length === 0) return null;
  return {
    branch: match[1].trim(),
    files,
  };
}

function isStashConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return STASH_CONFLICT_PATTERN.test(message);
}

function isUnresolvedIndexError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return UNRESOLVED_INDEX_PATTERN.test(message);
}

function parseGitIndexLockError(error: unknown): { lockPath: string | null } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = GIT_INDEX_LOCK_PATTERN.exec(message);
  if (!match) return null;
  return {
    lockPath: match[1]?.trim() || null,
  };
}

function isGitIndexWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return GIT_INDEX_WRITE_PATTERN.test(message);
}

function formatDirtyWorktreeDescription(files: string[]): string {
  const basenames = files.map((file) => file.split("/").pop() ?? file);
  if (basenames.length <= 3) {
    return `${basenames.join(", ")} ${pluralize(basenames.length, "has", "have")} uncommitted changes. Commit or stash before switching.`;
  }
  const remaining = basenames.length - 2;
  return `${basenames.slice(0, 2).join(", ")} and ${remaining} other ${pluralize(remaining, "file")} have uncommitted changes. Commit or stash before switching.`;
}

function handleCheckoutError(
  error: unknown,
  input: {
    api: NativeApi;
    branch: string;
    cwd: string;
    fallbackTitle: string;
    onSuccess: () => void;
    queryClient: QueryClient;
    runBranchAction: (action: () => Promise<void>) => void;
    onRequestDiscardStash: (input: { cwd: string }) => void;
  },
): void {
  const retryStashAndCheckout = async (): Promise<void> => {
    await input.api.git.stashAndCheckout({ cwd: input.cwd, branch: input.branch });
    await invalidateGitQueries(input.queryClient);
    input.onSuccess();
  };

  const addGitIndexLockToast = (error: unknown): void => {
    const lockError = parseGitIndexLockError(error);
    if (!lockError) return;
    const lockFileLabel = lockError.lockPath
      ? lockError.lockPath.split("/").slice(-2).join("/")
      : ".git/index.lock";
    addBranchRecoveryToast({
      type: "error",
      title: "Git index is locked.",
      description: `${lockFileLabel} already exists. Close any running Git operation, remove the stale lock file if none is running, then retry.`,
      data: { copyText: toBranchActionErrorMessage(error) },
      actionProps: {
        children: "Remove lock & retry",
        onClick: () => {
          input.runBranchAction(async () => {
            try {
              await input.api.git.removeIndexLock({ cwd: input.cwd });
              await retryStashAndCheckout();
            } catch (retryError) {
              handleCheckoutError(retryError, input);
            }
          });
        },
      },
    });
  };

  const addGitIndexWriteToast = (error: unknown): void => {
    addBranchRecoveryToast({
      type: "error",
      title: "Git index could not be written.",
      description:
        "Git could not update the repository index. Retry after any current Git operation finishes.",
      data: { copyText: toBranchActionErrorMessage(error) },
      actionProps: {
        children: "Retry stash & switch",
        onClick: () => {
          input.runBranchAction(async () => {
            try {
              await retryStashAndCheckout();
            } catch (retryError) {
              handleCheckoutError(retryError, input);
            }
          });
        },
      },
    });
  };

  const dirtyWorktree = parseDirtyWorktreeError(error);
  if (dirtyWorktree) {
    const copyText = toBranchActionErrorMessage(error);
    addBranchRecoveryToast({
      type: "warning",
      title: "Uncommitted changes block checkout.",
      description: formatDirtyWorktreeDescription(dirtyWorktree.files),
      data: { copyText },
      actionProps: {
        children: "Stash & Switch",
        onClick: () => {
          closeActiveBranchRecoveryToast();
          input.runBranchAction(async () => {
            try {
              await retryStashAndCheckout();
            } catch (stashError) {
              if (parseGitIndexLockError(stashError)) {
                addGitIndexLockToast(stashError);
                return;
              }
              if (isGitIndexWriteError(stashError)) {
                addGitIndexWriteToast(stashError);
                return;
              }
              if (isStashConflictError(stashError)) {
                await invalidateGitQueries(input.queryClient);
                input.onSuccess();
                addBranchRecoveryToast({
                  type: "warning",
                  title: "Changes saved, but not reapplied.",
                  description:
                    "Synara switched branches and kept your changes in a stash because they could not be restored onto this branch cleanly.",
                  data: { copyText: toBranchActionErrorMessage(stashError) },
                  actionProps: {
                    children: "Discard stash",
                    className:
                      "border-destructive bg-destructive text-white shadow-destructive/24 hover:bg-destructive/90",
                    onClick: () => {
                      closeActiveBranchRecoveryToast();
                      input.onRequestDiscardStash({ cwd: input.cwd });
                    },
                  },
                });
                return;
              }
              if (parseDirtyWorktreeError(stashError)) {
                addBranchRecoveryToast({
                  type: "error",
                  title: "Cannot switch branches.",
                  description:
                    "Some conflicting files are not covered by git stash, such as ignored files. Move or remove them before switching.",
                  data: { copyText: toBranchActionErrorMessage(stashError) },
                });
                return;
              }
              addBranchRecoveryToast({
                type: "error",
                title: "Failed to stash and switch.",
                description: toBranchActionErrorMessage(stashError),
                data: { copyText: toBranchActionErrorMessage(stashError) },
              });
            }
          });
        },
      },
    });
    return;
  }

  if (parseGitIndexLockError(error)) {
    addGitIndexLockToast(error);
    return;
  }
  if (isGitIndexWriteError(error)) {
    addGitIndexWriteToast(error);
    return;
  }

  addBranchRecoveryToast({
    type: "error",
    title: isUnresolvedIndexError(error)
      ? "Unresolved conflicts in the repository."
      : input.fallbackTitle,
    description: toBranchActionErrorMessage(error),
    data: { copyText: toBranchActionErrorMessage(error) },
  });
}

function getBranchTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
  resolvedActiveBranch: string | null;
  isJjBackend: boolean;
  jjLocalDefaultWorkspace?: boolean;
}): string {
  const {
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    isJjBackend,
    jjLocalDefaultWorkspace = false,
  } = input;
  if (jjLocalDefaultWorkspace) {
    return "@";
  }
  if (!resolvedActiveBranch) {
    return isJjBackend ? "Select base" : "Select branch";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    const special = getJjWorktreeBaseSpecialItems().find(
      (item) => item.value === resolvedActiveBranch,
    );
    return special ? `From ${special.label}` : `From ${resolvedActiveBranch}`;
  }
  return resolvedActiveBranch;
}

function getCreateBranchActionLabel(trimmedBranchQuery: string, isJjBackend: boolean): string {
  return trimmedBranchQuery.length > 0
    ? `Create and switch to "${trimmedBranchQuery}"`
    : `Create and switch to a new ${isJjBackend ? "bookmark" : "branch"}...`;
}

function getCurrentBranchChangeSummary(
  branch: GitBranch,
  branchStatus: VcsStatusResult | null | undefined,
): {
  fileCount: number;
  insertions: number;
  deletions: number;
} | null {
  if (!branch.current || !branchStatus?.hasChanges) {
    return null;
  }

  return {
    fileCount: branchStatus.files.length,
    insertions: branchStatus.insertions,
    deletions: branchStatus.deletions,
  };
}

export function BranchToolbarBranchSelector({
  projectId,
  projectKind,
  projectVcs,
  vcsBackend,
  activeThreadId,
  activeProjectCwd,
  activeThreadBranch,
  activeWorktreePath,
  branchCwd,
  threadWorkingDirectory,
  effectiveEnvMode,
  envLocked,
  hasServerThread,
  onSetThreadWorkspace,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
  variant = "toolbar",
}: BranchToolbarBranchSelectorProps) {
  const isPanel = variant === "panel";
  const queryClient = useQueryClient();
  const [isBranchMenuOpen, setIsBranchMenuOpen] = useState(false);
  const [isCreateBranchDialogOpen, setIsCreateBranchDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const deferredBranchQuery = useDeferredValue(branchQuery);

  const vcsTarget = makeVcsQueryTarget(
    { id: projectId, kind: projectKind, vcs: projectVcs },
    hasServerThread ? activeThreadId : null,
    vcsBackend,
    { threadWorkingDirectory },
  );
  const activeBackend = vcsTarget.backend;
  const isJjBackend = activeBackend === "jj";
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const jjLocalDefaultWorkspace = isJjLocalDefaultWorkspaceMode({
    backend: activeBackend,
    envMode: effectiveEnvMode,
    activeWorktreePath,
  });
  const branchesQuery = useQuery({
    ...vcsReferencesQueryOptions(vcsTarget),
    // Local JJ never switches bookmarks; skip listing unless we need worktree bases.
    enabled: !jjLocalDefaultWorkspace,
  });
  const branchStatusQuery = useQuery(vcsStatusQueryOptions(vcsTarget));
  const showJjChangeDistance = shouldShowJjChangeDistance({
    backend: activeBackend,
    envMode: effectiveEnvMode,
    activeWorktreePath,
  });
  const jjChangeDistance = getJjChangeDistancePresentation({
    distance: branchStatusQuery.data?.nearestBookmarkDistance,
    isLoading: branchStatusQuery.isLoading,
    hasError: branchStatusQuery.isError,
  });
  const branches = useMemo(
    () =>
      dedupeRemoteBranchesWithLocalMatches(
        (branchesQuery.data?.references ?? []).map(
          (reference): GitBranch => ({
            name: reference.name,
            current: reference.current,
            isDefault: reference.isDefault,
            worktreePath: reference.workspacePath,
            ...(reference.isRemote ? { isRemote: true } : {}),
            ...(reference.remoteName ? { remoteName: reference.remoteName } : {}),
          }),
        ),
      ),
    [branchesQuery.data?.references],
  );
  const hasOriginRemote = branchesQuery.data?.hasOriginRemote ?? false;
  const currentGitBranch =
    branchStatusQuery.data?.ref ?? branches.find((branch) => branch.current)?.name ?? null;
  const canonicalActiveBranch = resolveBranchToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadBranch,
    currentGitBranch,
    // Draft JJ worktree-base selection must keep the explicit base, including @ / @-.
    preferActiveThreadBranch: isJjBackend && isSelectingWorktreeBase,
    jjLocalDefaultWorkspace,
  });
  const branchNames = useMemo(() => branches.map((branch) => branch.name), [branches]);
  const branchByName = useMemo(
    () => new Map(branches.map((branch) => [branch.name, branch] as const)),
    [branches],
  );
  const jjWorktreeBaseSpecials = useMemo(
    () => (isJjBackend && isSelectingWorktreeBase ? getJjWorktreeBaseSpecialItems() : []),
    [isJjBackend, isSelectingWorktreeBase],
  );
  const jjWorktreeBaseSpecialByValue = useMemo(
    () => new Map(jjWorktreeBaseSpecials.map((item) => [item.value, item] as const)),
    [jjWorktreeBaseSpecials],
  );
  const trimmedBranchQuery = branchQuery.trim();
  const deferredTrimmedBranchQuery = deferredBranchQuery.trim();
  const normalizedDeferredBranchQuery = deferredTrimmedBranchQuery.toLowerCase();
  const prReference = parsePullRequestReference(trimmedBranchQuery);
  const checkoutPullRequestItemValue =
    activeBackend && prReference && onCheckoutPullRequestRequest
      ? `__checkout_pull_request__:${prReference}`
      : null;
  const canPrefillCreateBranch =
    !isSelectingWorktreeBase && !jjLocalDefaultWorkspace && trimmedBranchQuery.length > 0;
  const hasExactBranchMatch = branchByName.has(trimmedBranchQuery);
  const branchPickerItems = useMemo(() => {
    const items = [...jjWorktreeBaseSpecials.map((item) => item.value), ...branchNames];
    if (checkoutPullRequestItemValue) {
      items.unshift(checkoutPullRequestItemValue);
    }
    return items;
  }, [branchNames, checkoutPullRequestItemValue, jjWorktreeBaseSpecials]);
  const filteredBranchPickerItems = useMemo(
    () =>
      normalizedDeferredBranchQuery.length === 0
        ? branchPickerItems
        : branchPickerItems.filter((itemValue) => {
            if (itemValue.toLowerCase().includes(normalizedDeferredBranchQuery)) {
              return true;
            }
            const special = jjWorktreeBaseSpecialByValue.get(itemValue);
            if (!special) return false;
            return (
              special.label.toLowerCase().includes(normalizedDeferredBranchQuery) ||
              special.description.toLowerCase().includes(normalizedDeferredBranchQuery)
            );
          }),
    [branchPickerItems, jjWorktreeBaseSpecialByValue, normalizedDeferredBranchQuery],
  );
  const [resolvedActiveBranch, setOptimisticBranch] = useOptimistic(
    canonicalActiveBranch,
    (_currentBranch: string | null, optimisticBranch: string | null) => optimisticBranch,
  );
  const [isBranchActionPending, startBranchActionTransition] = useTransition();
  const [stashDiscardDialog, setStashDiscardDialog] = useState<StashDiscardDialogState | null>(
    null,
  );
  const [isDroppingStash, setIsDroppingStash] = useState(false);
  const shouldVirtualizeBranchList = filteredBranchPickerItems.length > 40;

  useEffect(() => {
    if (
      !shouldSyncLocalThreadBranch({
        envMode: effectiveEnvMode,
        activeWorktreePath,
        activeThreadBranch,
        currentGitBranch,
        hasServerThread,
        isBranchActionPending,
        preferActiveThreadBranch: isJjBackend && isSelectingWorktreeBase,
        jjLocalDefaultWorkspace,
      })
    ) {
      return;
    }

    onSetThreadWorkspace({ branch: currentGitBranch, worktreePath: null });
  }, [
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    hasServerThread,
    isBranchActionPending,
    isJjBackend,
    isSelectingWorktreeBase,
    jjLocalDefaultWorkspace,
    onSetThreadWorkspace,
  ]);

  // Clear sticky bookmark metadata when Local JJ is following default `@`.
  useEffect(() => {
    if (!jjLocalDefaultWorkspace || activeThreadBranch === null) {
      return;
    }
    onSetThreadWorkspace({ branch: null, worktreePath: null });
  }, [activeThreadBranch, jjLocalDefaultWorkspace, onSetThreadWorkspace]);

  const runBranchAction = (action: () => Promise<void>) => {
    startBranchActionTransition(async () => {
      await action().catch(() => undefined);
      await invalidateVcsQueries(queryClient).catch(() => undefined);
    });
  };

  const openCreateBranchDialog = useCallback(() => {
    setCreateBranchName(canPrefillCreateBranch && !hasExactBranchMatch ? trimmedBranchQuery : "");
    setIsBranchMenuOpen(false);
    setIsCreateBranchDialogOpen(true);
  }, [canPrefillCreateBranch, hasExactBranchMatch, trimmedBranchQuery]);

  const openStashDiscardDialog = useCallback((input: { cwd: string }) => {
    const api = readNativeApi();
    setStashDiscardDialog({
      cwd: input.cwd,
      error: api ? null : "Native API is unavailable.",
      info: null,
      loading: Boolean(api),
    });
    if (!api) return;
    void api.git.stashInfo({ cwd: input.cwd }).then(
      (info) => {
        setStashDiscardDialog((current) =>
          current?.cwd === input.cwd ? { ...current, error: null, info, loading: false } : current,
        );
      },
      (error) => {
        setStashDiscardDialog((current) =>
          current?.cwd === input.cwd
            ? {
                ...current,
                error: toBranchActionErrorMessage(error),
                info: null,
                loading: false,
              }
            : current,
        );
      },
    );
  }, []);

  const discardStashFromDialog = useCallback(() => {
    const dialog = stashDiscardDialog;
    const api = readNativeApi();
    if (!dialog || !api || isDroppingStash) return;
    setIsDroppingStash(true);
    runBranchAction(async () => {
      try {
        if (!dialog.info) return;
        await api.git.stashDrop({ cwd: dialog.cwd, stashRef: dialog.info.stashRef });
        setStashDiscardDialog(null);
      } finally {
        setIsDroppingStash(false);
      }
    });
  }, [isDroppingStash, runBranchAction, stashDiscardDialog]);

  const selectWorktreeBaseRef = (ref: string) => {
    onSetThreadWorkspace({ branch: ref, worktreePath: null });
    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();
  };

  const selectBranch = (branch: GitBranch) => {
    const api = readNativeApi();
    if (!api || !branchCwd || isBranchActionPending || !activeBackend) return;

    // Local JJ must never mutate the default workspace via bookmark switch.
    if (jjLocalDefaultWorkspace) {
      return;
    }

    // In new-worktree mode, selecting a ref only sets the createWorkspace source.
    if (isSelectingWorktreeBase) {
      selectWorktreeBaseRef(branch.name);
      return;
    }

    const selectionTarget = resolveBranchSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      branch,
    });

    // If the branch already lives in a worktree, point the thread there.
    if (selectionTarget.reuseExistingWorktree) {
      onSetThreadWorkspace({
        branch: branch.name,
        worktreePath: selectionTarget.nextWorktreePath,
      });
      setIsBranchMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedBranchName = branch.isRemote
      ? activeBackend === "jj"
        ? branch.name.replace(/@[^@]+$/u, "")
        : deriveLocalBranchNameFromRemoteRef(branch.name)
      : branch.name;
    const switchTarget = makeVcsQueryTarget(
      { id: projectId, kind: projectKind, vcs: projectVcs },
      hasServerThread ? activeThreadId : null,
      vcsBackend,
      { threadWorkingDirectory },
    );

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(selectedBranchName);
      try {
        const switched = await api.vcs.switchReference({
          projectId,
          ...(switchTarget.threadId ? { threadId: switchTarget.threadId } : {}),
          expectedEpoch: switchTarget.epoch,
          ref: branch.name,
        });
        const nextBranchName = switched.ref ?? selectedBranchName;
        setOptimisticBranch(nextBranchName);
        onSetThreadWorkspace({
          branch: nextBranchName,
          worktreePath: selectionTarget.nextWorktreePath,
        });
        await invalidateVcsQueries(queryClient);
      } catch (error) {
        if (activeBackend === "git") {
          handleCheckoutError(error, {
            api,
            branch: branch.name,
            cwd: selectionTarget.checkoutCwd,
            fallbackTitle: "Failed to checkout branch.",
            onSuccess: () => {
              setOptimisticBranch(selectedBranchName);
              onSetThreadWorkspace({
                branch: selectedBranchName,
                worktreePath: selectionTarget.nextWorktreePath,
              });
            },
            queryClient,
            runBranchAction,
            onRequestDiscardStash: openStashDiscardDialog,
          });
        } else {
          toastManager.add({
            type: "error",
            title: "Failed to switch bookmark.",
            description: toBranchActionErrorMessage(error),
          });
        }
        return;
      }
    });
  };

  const createBranch = (rawName: string) => {
    const name = rawName.trim();
    const api = readNativeApi();
    if (!api || !branchCwd || !name || isBranchActionPending || !activeBackend) return;

    setIsBranchMenuOpen(false);
    onComposerFocusRequest?.();

    runBranchAction(async () => {
      setOptimisticBranch(name);

      try {
        await api.vcs.createReference({
          projectId,
          ...(vcsTarget.threadId ? { threadId: vcsTarget.threadId } : {}),
          expectedEpoch: vcsTarget.epoch,
          name,
          publish: hasOriginRemote,
        });
        try {
          await api.vcs.switchReference({
            projectId,
            ...(vcsTarget.threadId ? { threadId: vcsTarget.threadId } : {}),
            expectedEpoch: vcsTarget.epoch,
            ref: name,
          });
        } catch (error) {
          if (activeBackend === "git") {
            handleCheckoutError(error, {
              api,
              branch: name,
              cwd: branchCwd,
              fallbackTitle: "Failed to checkout branch.",
              onSuccess: () => {
                setOptimisticBranch(name);
                onSetThreadWorkspace({
                  branch: name,
                  worktreePath: activeWorktreePath,
                });
                setBranchQuery("");
                setCreateBranchName("");
              },
              queryClient,
              runBranchAction,
              onRequestDiscardStash: openStashDiscardDialog,
            });
          } else {
            toastManager.add({
              type: "error",
              title: "Bookmark was created, but switching failed.",
              description: toBranchActionErrorMessage(error),
            });
          }
          return;
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: activeBackend === "jj" ? "Failed to create bookmark." : "Failed to create branch.",
          description: toBranchActionErrorMessage(error),
        });
        return;
      }

      setOptimisticBranch(name);
      onSetThreadWorkspace({
        branch: name,
        worktreePath: activeWorktreePath,
      });
      setBranchQuery("");
      setCreateBranchName("");
    });
  };

  useEffect(() => {
    if (effectiveEnvMode !== "worktree" || activeWorktreePath || activeThreadBranch) {
      return;
    }
    const defaultBase = resolveDefaultWorktreeBaseRef({
      backend: activeBackend,
      currentReference: currentGitBranch,
    });
    if (!defaultBase) {
      return;
    }
    onSetThreadWorkspace({ branch: defaultBase, worktreePath: null });
  }, [
    activeBackend,
    activeThreadBranch,
    activeWorktreePath,
    currentGitBranch,
    effectiveEnvMode,
    onSetThreadWorkspace,
  ]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsBranchMenuOpen(open);
      if (!open) {
        setBranchQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: vcsQueryKeys.referencesFor(vcsTarget),
      });
    },
    [queryClient, vcsTarget],
  );

  const branchListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const branchListVirtualizer = useVirtualizer({
    count: filteredBranchPickerItems.length,
    estimateSize: (index) => {
      const itemValue = filteredBranchPickerItems[index];
      if (!itemValue) return 28;
      if (itemValue === checkoutPullRequestItemValue) return 44;
      if (jjWorktreeBaseSpecialByValue.has(itemValue)) return 44;
      const branch = branchByName.get(itemValue);
      return branch && getCurrentBranchChangeSummary(branch, branchStatusQuery.data) ? 48 : 28;
    },
    getScrollElement: () => branchListScrollElementRef.current,
    overscan: 12,
    enabled: isBranchMenuOpen && shouldVirtualizeBranchList,
    initialRect: {
      height: 224,
      width: 0,
    },
  });
  const virtualBranchRows = branchListVirtualizer.getVirtualItems();
  const setBranchListRef = useCallback(
    (element: HTMLDivElement | null) => {
      branchListScrollElementRef.current =
        (element?.parentElement as HTMLDivElement | null) ?? null;
      if (element) {
        branchListVirtualizer.measure();
      }
    },
    [branchListVirtualizer],
  );

  useEffect(() => {
    if (!isBranchMenuOpen || !shouldVirtualizeBranchList) return;
    queueMicrotask(() => {
      branchListVirtualizer.measure();
    });
  }, [
    branchListVirtualizer,
    branchStatusQuery.data,
    filteredBranchPickerItems.length,
    isBranchMenuOpen,
    shouldVirtualizeBranchList,
  ]);

  const triggerLabel = getBranchTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveBranch,
    isJjBackend,
    jjLocalDefaultWorkspace,
  });

  function renderPickerItem(itemValue: string, index: number, style?: CSSProperties) {
    const specialBase = jjWorktreeBaseSpecialByValue.get(itemValue);
    if (specialBase) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => selectWorktreeBaseRef(itemValue)}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
            <span className="truncate font-medium">{specialBase.label}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {specialBase.description}
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (checkoutPullRequestItemValue && itemValue === checkoutPullRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          style={style}
          onClick={() => {
            if (!prReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsBranchMenuOpen(false);
            setBranchQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(prReference);
          }}
        >
          <div className="flex min-w-0 flex-col items-start py-1">
            <span className="truncate font-medium">Checkout Pull Request</span>
            <span className="truncate text-muted-foreground text-xs">{prReference}</span>
          </div>
        </ComboboxItem>
      );
    }

    const branch = branchByName.get(itemValue);
    if (!branch) return null;

    const hasSecondaryWorktree = branch.worktreePath && branch.worktreePath !== activeProjectCwd;
    const currentBranchChangeSummary = getCurrentBranchChangeSummary(
      branch,
      branchStatusQuery.data,
    );
    const badge = branch.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : branch.isRemote
          ? "remote"
          : branch.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        className={
          itemValue === resolvedActiveBranch
            ? "bg-[var(--color-background-elevated-secondary)] text-[var(--color-text-foreground)]"
            : undefined
        }
        style={style}
        onClick={() => selectBranch(branch)}
      >
        <div className="flex w-full items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate">{itemValue}</span>
              {badge && (
                <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>
              )}
            </div>
            {currentBranchChangeSummary ? (
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] leading-4">
                <span className="text-muted-foreground">
                  Uncommitted: {currentBranchChangeSummary.fileCount.toLocaleString()}{" "}
                  {pluralize(currentBranchChangeSummary.fileCount, "file")}
                </span>
                <span className="font-mono tabular-nums text-success">
                  +{currentBranchChangeSummary.insertions.toLocaleString()}
                </span>
                <span className="font-mono tabular-nums text-destructive">
                  -{currentBranchChangeSummary.deletions.toLocaleString()}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </ComboboxItem>
    );
  }

  // JJ Local always tracks the default workspace `@` — no bookmark switcher.
  if (jjLocalDefaultWorkspace) {
    if (isPanel) {
      return (
        <div
          className={cn(ENVIRONMENT_ROW_CLASS_NAME, "cursor-default hover:bg-transparent")}
          title={jjChangeDistance.title}
        >
          <EnvironmentRowBody
            icon={<CentralIcon name="branch" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
            label={jjChangeDistance.label}
            trailing={
              jjChangeDistance.trailing ? (
                <span className="max-w-[10rem] truncate text-[11px] text-muted-foreground">
                  {jjChangeDistance.trailing}
                </span>
              ) : null
            }
          />
        </div>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-1.5 px-1.5 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)]"
        title={jjChangeDistance.title}
      >
        <CentralIcon name="branch" className="size-3.5 shrink-0" />
        <span className="max-w-[240px] truncate">{jjChangeDistance.label}</span>
        {jjChangeDistance.trailing ? (
          <span className="max-w-[120px] truncate opacity-60">{jjChangeDistance.trailing}</span>
        ) : null}
      </span>
    );
  }

  const workspaceChangeDistance = showJjChangeDistance ? jjChangeDistance : null;

  return (
    <Combobox
      items={branchPickerItems}
      filteredItems={filteredBranchPickerItems}
      autoHighlight
      virtualized={shouldVirtualizeBranchList}
      onItemHighlighted={(_value, eventDetails) => {
        if (!isBranchMenuOpen || eventDetails.index < 0) return;
        branchListVirtualizer.scrollToIndex(eventDetails.index, { align: "auto" });
      }}
      onOpenChange={handleOpenChange}
      open={isBranchMenuOpen}
      value={resolvedActiveBranch}
    >
      <ComboboxTrigger
        className={
          isPanel
            ? ENVIRONMENT_ROW_CLASS_NAME
            : `${COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME} disabled:cursor-not-allowed disabled:opacity-50`
        }
        disabled={(branchesQuery.isLoading && branches.length === 0) || isBranchActionPending}
        title={workspaceChangeDistance?.title}
      >
        {isPanel ? (
          <EnvironmentRowBody
            icon={<CentralIcon name="branch" className={ENVIRONMENT_ROW_ICON_CLASS_NAME} />}
            label={workspaceChangeDistance?.label ?? triggerLabel}
            trailing={
              <>
                {workspaceChangeDistance?.trailing ? (
                  <span className="max-w-[10rem] truncate text-[11px] text-muted-foreground">
                    {workspaceChangeDistance.trailing}
                  </span>
                ) : null}
                <EnvironmentRowChevron />
              </>
            }
          />
        ) : (
          <>
            <CentralIcon name="branch" className="size-3.5 shrink-0" />
            <span className="max-w-[240px] truncate">
              {workspaceChangeDistance?.label ?? triggerLabel}
            </span>
            {workspaceChangeDistance?.trailing ? (
              <span className="max-w-[120px] truncate opacity-60">
                {workspaceChangeDistance.trailing}
              </span>
            ) : null}
            <ChevronDownIcon className="size-3 opacity-60" />
          </>
        )}
      </ComboboxTrigger>
      <ComboboxPopup align="end" side={isPanel ? "bottom" : "top"} className="w-80">
        <div className="border-b p-1">
          <ComboboxInput
            className="rounded-xl border-[color:var(--color-border)] bg-[var(--color-background-control-opaque)] shadow-none before:hidden has-focus-visible:border-[color:var(--color-border-focus)] has-focus-visible:ring-0 [&_input]:font-sans"
            inputClassName="ring-0"
            placeholder={isJjBackend ? "Search bookmarks..." : "Search branches..."}
            showTrigger={false}
            size="sm"
            value={branchQuery}
            onChange={(event) => setBranchQuery(event.target.value)}
          />
        </div>
        <ComboboxEmpty>{isJjBackend ? "No bookmarks found." : "No branches found."}</ComboboxEmpty>

        <ComboboxList ref={setBranchListRef} className="max-h-56">
          {shouldVirtualizeBranchList ? (
            <div
              className="relative"
              style={{
                height: `${branchListVirtualizer.getTotalSize()}px`,
              }}
            >
              {virtualBranchRows.map((virtualRow) => {
                const itemValue = filteredBranchPickerItems[virtualRow.index];
                if (!itemValue) return null;
                return renderPickerItem(itemValue, virtualRow.index, {
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                });
              })}
            </div>
          ) : (
            filteredBranchPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))
          )}
        </ComboboxList>
        {!isSelectingWorktreeBase ? (
          <div className="border-t border-[color:var(--color-border-light)] p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-text-foreground)] transition-colors hover:bg-[var(--color-background-elevated-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isBranchActionPending}
              onClick={openCreateBranchDialog}
            >
              <PlusIcon className="size-3.5 shrink-0" />
              <span className="truncate">
                {getCreateBranchActionLabel(trimmedBranchQuery, isJjBackend)}
              </span>
            </button>
          </div>
        ) : null}
      </ComboboxPopup>
      <Dialog
        open={isCreateBranchDialogOpen}
        onOpenChange={(open) => {
          setIsCreateBranchDialogOpen(open);
          if (!open) {
            setCreateBranchName("");
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isJjBackend ? "Create Bookmark" : "Create Branch"}</DialogTitle>
            <DialogDescription>
              {`Create and switch to a new ${isJjBackend ? "bookmark" : "branch"} from ${resolvedActiveBranch ?? currentGitBranch ?? (isJjBackend ? "the current change" : "the current HEAD")}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                const nextName = createBranchName.trim();
                if (!nextName || branchByName.has(nextName)) {
                  return;
                }
                setIsCreateBranchDialogOpen(false);
                createBranch(nextName);
              }}
            >
              <div className="space-y-1.5">
                <label className="block font-medium text-sm" htmlFor="branch-create-name">
                  {isJjBackend ? "Bookmark name" : "Branch name"}
                </label>
                <Input
                  autoFocus
                  id="branch-create-name"
                  placeholder="feature/my-change"
                  value={createBranchName}
                  onChange={(event) => setCreateBranchName(event.target.value)}
                />
              </div>
              {branchByName.has(createBranchName.trim()) ? (
                <p className="text-destructive text-sm">
                  {`A ${isJjBackend ? "bookmark" : "branch"} with this name already exists.`}
                </p>
              ) : null}
              <DialogFooter variant="bare">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    setIsCreateBranchDialogOpen(false);
                    setCreateBranchName("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    createBranchName.trim().length === 0 ||
                    branchByName.has(createBranchName.trim())
                  }
                >
                  Create and switch
                </Button>
              </DialogFooter>
            </form>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={stashDiscardDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setStashDiscardDialog(null);
            setIsDroppingStash(false);
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Discard saved stash?</DialogTitle>
            <DialogDescription>
              This will permanently drop the stash entry that preserved your uncommitted changes.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {stashDiscardDialog?.loading ? (
              <p className="text-muted-foreground text-sm">Loading stash details...</p>
            ) : stashDiscardDialog?.error ? (
              <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm">
                {stashDiscardDialog.error}
              </p>
            ) : stashDiscardDialog?.info ? (
              <>
                <div className="grid gap-2 rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-secondary)] p-3 text-sm">
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Branch</span>
                    <span className="min-w-0 truncate font-medium">
                      {stashDiscardDialog.info.branch ?? currentGitBranch ?? "Detached HEAD"}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Worktree</span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.cwd}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Stash</span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {stashDiscardDialog.info.stashRef}
                    </span>
                  </div>
                  <div className="flex min-w-0 gap-2">
                    <span className="w-20 shrink-0 text-muted-foreground">Name</span>
                    <span className="min-w-0 truncate">{stashDiscardDialog.info.message}</span>
                  </div>
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-sm">
                    Changed files ({stashDiscardDialog.info.files.length})
                  </p>
                  {stashDiscardDialog.info.files.length > 0 ? (
                    <ul className="max-h-48 overflow-auto rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-control-opaque)] py-1">
                      {stashDiscardDialog.info.files.map((file) => (
                        <li
                          className="truncate px-3 py-1 font-mono text-muted-foreground text-xs"
                          key={file}
                          title={file}
                        >
                          {file}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="rounded-lg border border-[color:var(--color-border-light)] px-3 py-2 text-muted-foreground text-sm">
                      Git did not report changed file names for this stash.
                    </p>
                  )}
                </div>
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={() => {
                setStashDiscardDialog(null);
                setIsDroppingStash(false);
              }}
            >
              Keep stash
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={!stashDiscardDialog?.info || isDroppingStash}
              onClick={discardStashFromDialog}
            >
              {isDroppingStash ? "Discarding..." : "Discard stash"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Combobox>
  );
}
