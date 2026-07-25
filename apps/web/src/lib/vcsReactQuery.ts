import type {
  ProjectId,
  ProjectVcsState,
  ModelSelection,
  ProviderStartOptions,
  ThreadId,
  VcsBackend,
  VcsCreateReferenceInput,
  VcsCreateWorkspaceInput,
  VcsHandoffThreadInput,
  VcsPreparePullRequestThreadInput,
  VcsReadDiffInput,
  VcsRemoveWorkspaceInput,
  VcsStackedAction,
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
  threadId: ThreadId | null | undefined,
  selectedBackend: VcsBackend,
): VcsQueryTarget {
  const vcs = project?.vcs ?? { epoch: 0, binding: null };
  const backend = vcs.binding?.backend ?? null;
  return {
    projectId: project?.id ?? null,
    threadId: threadId ?? null,
    epoch: vcs.epoch,
    backend: backend === selectedBackend ? backend : null,
  };
}

function requestTarget(target: VcsQueryTarget) {
  if (!target.projectId || !target.backend) {
    throw new Error(
      "Configure this project for the global source control backend before using source control.",
    );
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
  githubRepositories: ["vcs", "github-repository"] as const,
  pullRequests: ["vcs", "pull-request"] as const,
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
  githubRepository: (target: VcsQueryTarget) =>
    [
      "vcs",
      "github-repository",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
    ] as const,
  pullRequest: (target: VcsQueryTarget, reference: string | null) =>
    [
      "vcs",
      "pull-request",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
      reference,
    ] as const,
  pullRequestSnapshot: (target: VcsQueryTarget, reference: string | null) =>
    [
      "vcs",
      "pull-request",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
      "snapshot",
      reference,
    ] as const,
};

export const vcsMutationKeys = {
  runStackedAction: (target: VcsQueryTarget) =>
    [
      "vcs",
      "mutation",
      "run-stacked-action",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
    ] as const,
  pull: (target: VcsQueryTarget) =>
    [
      "vcs",
      "mutation",
      "pull",
      target.projectId,
      target.threadId,
      target.epoch,
      target.backend,
    ] as const,
  preparePullRequestThread: (target: VcsQueryTarget) =>
    [
      "vcs",
      "mutation",
      "prepare-pull-request-thread",
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

export function vcsResolvePullRequestQueryOptions(input: {
  target: VcsQueryTarget;
  reference: string | null;
}) {
  return queryOptions({
    queryKey: vcsQueryKeys.pullRequest(input.target, input.reference),
    queryFn: () => {
      if (!input.reference) {
        throw new Error("Pull request lookup is unavailable.");
      }
      return ensureNativeApi().vcs.resolvePullRequest({
        ...requestTarget(input.target),
        reference: input.reference,
      });
    },
    enabled:
      input.target.projectId !== null &&
      input.target.backend !== null &&
      input.reference !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function vcsGithubRepositoryQueryOptions(
  target: VcsQueryTarget,
  enabled = true,
) {
  return queryOptions({
    queryKey: vcsQueryKeys.githubRepository(target),
    queryFn: () => ensureNativeApi().vcs.githubRepository(requestTarget(target)),
    enabled:
      enabled && target.projectId !== null && target.backend !== null,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

export function vcsPullRequestSnapshotQueryOptions(input: {
  target: VcsQueryTarget;
  reference: string | null;
  enabled?: boolean;
}) {
  return queryOptions({
    queryKey: vcsQueryKeys.pullRequestSnapshot(input.target, input.reference),
    queryFn: () => {
      if (!input.reference) {
        throw new Error("Pull request snapshot is unavailable.");
      }
      return ensureNativeApi().vcs.pullRequestSnapshot({
        ...requestTarget(input.target),
        reference: input.reference,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.target.projectId !== null &&
      input.target.backend !== null &&
      input.reference !== null,
    staleTime: 30_000,
    refetchInterval: (query) =>
      query.state.data && query.state.data.pullRequest.state !== "open"
        ? false
        : 60_000,
    refetchOnWindowFocus: (query) =>
      !query.state.data || query.state.data.pullRequest.state === "open",
    refetchOnReconnect: true,
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

export function vcsHandoffThreadMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: ["vcs", "mutation", "handoff-thread"] as const,
    mutationFn: (request: VcsHandoffThreadInput) =>
      ensureNativeApi().vcs.handoffThread(request),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsPreparePullRequestThreadMutationOptions(input: {
  target: VcsQueryTarget;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: vcsMutationKeys.preparePullRequestThread(input.target),
    mutationFn: (
      request: Pick<VcsPreparePullRequestThreadInput, "reference" | "mode">,
    ) =>
      ensureNativeApi().vcs.preparePullRequestThread({
        ...requestTarget(input.target),
        ...request,
      }),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsRunStackedActionMutationOptions(input: {
  target: VcsQueryTarget;
  queryClient: QueryClient;
  model?: string | null;
  modelSelection?: ModelSelection | null;
  codexHomePath?: string | null;
  providerOptions?: ProviderStartOptions | null;
}) {
  return mutationOptions({
    mutationKey: vcsMutationKeys.runStackedAction(input.target),
    mutationFn: (request: {
      actionId: string;
      action: VcsStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
    }) =>
      ensureNativeApi().vcs.runStackedAction({
        ...requestTarget(input.target),
        ...request,
        ...(input.codexHomePath
          ? { codexHomePath: input.codexHomePath }
          : {}),
        ...(input.model ? { textGenerationModel: input.model } : {}),
        ...(input.modelSelection
          ? { textGenerationModelSelection: input.modelSelection }
          : {}),
        ...(input.providerOptions
          ? { providerOptions: input.providerOptions }
          : {}),
      }),
    onSettled: mutationInvalidation(input.queryClient),
  });
}

export function vcsPullMutationOptions(input: {
  target: VcsQueryTarget;
  queryClient: QueryClient;
}) {
  return mutationOptions({
    mutationKey: vcsMutationKeys.pull(input.target),
    mutationFn: () => ensureNativeApi().vcs.pull(requestTarget(input.target)),
    onSettled: mutationInvalidation(input.queryClient),
  });
}
