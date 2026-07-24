import type {
  ProjectId,
  ProjectVcsState,
  ThreadId,
  VcsBackend,
  VcsCreateReferenceInput,
  VcsCreateWorkspaceInput,
  VcsReadDiffInput,
  VcsRemoveWorkspaceInput,
  VcsSwitchReferenceInput,
} from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";

const VCS_STATUS_STALE_TIME_MS = 30_000;
const VCS_STATUS_REFETCH_INTERVAL_MS = 300_000;
const VCS_REFERENCES_STALE_TIME_MS = 15_000;
const VCS_REFERENCES_REFETCH_INTERVAL_MS = 300_000;
const VCS_DIFF_STALE_TIME_MS = 5_000;
export const VCS_DIFF_LIVE_REFETCH_INTERVAL_MS = 4_000;

export interface VcsQueryTarget {
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
  readonly epoch: number;
  readonly backend: VcsBackend | null;
}

export function makeVcsQueryTarget(
  project:
    | {
        readonly id: ProjectId;
        readonly vcs?: ProjectVcsState | undefined;
      }
    | null
    | undefined,
  threadId?: ThreadId | null,
): VcsQueryTarget {
  const vcs = project?.vcs ?? { epoch: 0, binding: null };
  return {
    projectId: project?.id ?? null,
    threadId: threadId ?? null,
    epoch: vcs.epoch,
    backend: vcs.binding?.backend ?? null,
  };
}

function requestTarget(target: VcsQueryTarget) {
  if (!target.projectId || !target.backend) {
    throw new Error("Choose Git or JJ for this project before using source control.");
  }
  return {
    projectId: target.projectId,
    ...(target.threadId ? { threadId: target.threadId } : {}),
    expectedEpoch: target.epoch,
  };
}

export const vcsQueryKeys = {
  all: ["vcs"] as const,
  statuses: ["vcs", "status"] as const,
  references: ["vcs", "references"] as const,
  diffs: ["vcs", "diff"] as const,
  workspaces: ["vcs", "workspaces"] as const,
  status: (target: VcsQueryTarget) =>
    [
      "vcs",
      "status",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
    ] as const,
  referencesFor: (target: VcsQueryTarget) =>
    [
      "vcs",
      "references",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
    ] as const,
  diff: (target: VcsQueryTarget, scope: VcsReadDiffInput["scope"]) =>
    [
      "vcs",
      "diff",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
      scope,
    ] as const,
  workspacesFor: (target: VcsQueryTarget) =>
    [
      "vcs",
      "workspaces",
      target.projectId,
      target.epoch,
      target.backend,
    ] as const,
};

export function invalidateVcsQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: vcsQueryKeys.all });
}

export function vcsStatusQueryOptions(
  target: VcsQueryTarget,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: vcsQueryKeys.status(target),
    queryFn: () => ensureNativeApi().vcs.status(requestTarget(target)),
    enabled:
      (options?.enabled ?? true) && target.projectId !== null && target.backend !== null,
    staleTime: VCS_STATUS_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: "always",
    refetchInterval: VCS_STATUS_REFETCH_INTERVAL_MS,
  });
}

export function vcsReferencesQueryOptions(
  target: VcsQueryTarget,
  options?: { enabled?: boolean },
) {
  return queryOptions({
    queryKey: vcsQueryKeys.referencesFor(target),
    queryFn: () => ensureNativeApi().vcs.listReferences(requestTarget(target)),
    enabled:
      (options?.enabled ?? true) && target.projectId !== null && target.backend !== null,
    staleTime: VCS_REFERENCES_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: VCS_REFERENCES_REFETCH_INTERVAL_MS,
  });
}

export function vcsDiffQueryOptions(input: {
  target: VcsQueryTarget;
  scope?: VcsReadDiffInput["scope"];
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const scope = input.scope ?? "workingTree";
  return queryOptions({
    queryKey: vcsQueryKeys.diff(input.target, scope),
    queryFn: () =>
      ensureNativeApi().vcs.readDiff({
        ...requestTarget(input.target),
        scope,
      }),
    enabled:
      (input.enabled ?? true) &&
      input.target.projectId !== null &&
      input.target.backend !== null &&
      !(input.target.backend === "jj" && scope === "staged"),
    staleTime: VCS_DIFF_STALE_TIME_MS,
    ...(input.refetchInterval !== undefined
      ? { refetchInterval: input.refetchInterval }
      : {}),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

function mutationInvalidation(queryClient: QueryClient) {
  return async () => {
    await invalidateVcsQueries(queryClient);
  };
}

export function vcsSetBackendMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "set-backend"] as const,
    mutationFn: (request: {
      projectId: ProjectId;
      expectedEpoch: number;
      backend: VcsBackend;
    }) => ensureNativeApi().vcs.setBackend(request),
    onSuccess: mutationInvalidation(input.queryClient),
  });
}

export function vcsCreateReferenceMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "create-reference"] as const,
    mutationFn: (request: VcsCreateReferenceInput) =>
      ensureNativeApi().vcs.createReference(request),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsSwitchReferenceMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "switch-reference"] as const,
    mutationFn: (request: VcsSwitchReferenceInput) =>
      ensureNativeApi().vcs.switchReference(request),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsCreateWorkspaceMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "create-workspace"] as const,
    mutationFn: (request: VcsCreateWorkspaceInput) =>
      ensureNativeApi().vcs.createWorkspace(request),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsRemoveWorkspaceMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "remove-workspace"] as const,
    mutationFn: (request: VcsRemoveWorkspaceInput) =>
      ensureNativeApi().vcs.removeWorkspace(request),
    onSettled: mutationInvalidation(input.queryClient),
  });
}
