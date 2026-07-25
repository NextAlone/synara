import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  ProjectId,
  ProjectVcsBinding,
  ServerSettingsError,
  ThreadId,
  VcsBackend,
  VcsConfigureProjectInput,
  VcsConfigureProjectResult,
  VcsCreateReferenceInput,
  VcsCreateReferenceResult,
  VcsCreateWorkspaceInput,
  VcsCreateWorkspaceResult,
  VcsHandoffThreadInput,
  VcsHandoffThreadResult,
  VcsGitHubRepositoryInput,
  VcsGitHubRepositoryResult,
  VcsListReferencesInput,
  VcsListReferencesResult,
  VcsListWorkspacesInput,
  VcsListWorkspacesResult,
  VcsReadDiffInput,
  VcsReadDiffResult,
  VcsRemoveWorkspaceInput,
  VcsRemoveWorkspaceResult,
  VcsPullInput,
  VcsPullResult,
  VcsPullRequestSnapshotInput,
  VcsPullRequestSnapshotResult,
  VcsPullRequestStatus,
  VcsPreparePullRequestThreadInput,
  VcsPreparePullRequestThreadResult,
  VcsResolvePullRequestInput,
  VcsResolvePullRequestResult,
  VcsRunStackedActionInput,
  VcsSetBackendInput,
  VcsSetBackendResult,
  VcsStatusInput,
  VcsStatusResult,
  VcsSwitchReferenceInput,
  VcsSwitchReferenceResult,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { GitManagerServiceError } from "../../git/Errors.ts";
import type { GitHubCliError, TextGenerationError } from "../../git/Errors.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { JjCommandError, ProjectVcsError } from "../Errors.ts";

export type ProjectVcsServiceError =
  | ProjectVcsError
  | JjCommandError
  | GitManagerServiceError
  | GitHubCliError
  | TextGenerationError
  | ProjectionRepositoryError
  | OrchestrationDispatchError
  | ServerSettingsError;

export interface ResolvedProjectVcsTarget {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly backend: VcsBackend;
  readonly epoch: number;
  readonly binding: ProjectVcsBinding;
  /** Thread-persisted branch/bookmark preference, used to disambiguate JJ bookmarks. */
  readonly preferredReference: string | null;
  /** Server-derived project cwd in the selected local/workspace checkout. */
  readonly cwd: string;
}

export interface MaterializedPullRequestHead {
  readonly pullRequest: VcsPullRequestStatus;
  readonly branch: string;
  readonly revision: string;
}

export interface ProjectVcsShape {
  readonly getBackend: Effect.Effect<VcsBackend, ProjectVcsServiceError>;
  readonly setBackend: (
    input: VcsSetBackendInput,
  ) => Effect.Effect<VcsSetBackendResult, ProjectVcsServiceError>;
  readonly configureProject: (
    input: VcsConfigureProjectInput,
  ) => Effect.Effect<VcsConfigureProjectResult, ProjectVcsServiceError>;
  readonly resolveTarget: (
    input: VcsStatusInput,
  ) => Effect.Effect<ResolvedProjectVcsTarget, ProjectVcsServiceError>;
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, ProjectVcsServiceError>;
  readonly readDiff: (
    input: VcsReadDiffInput,
  ) => Effect.Effect<VcsReadDiffResult, ProjectVcsServiceError>;
  readonly listReferences: (
    input: VcsListReferencesInput,
  ) => Effect.Effect<VcsListReferencesResult, ProjectVcsServiceError>;
  readonly createReference: (
    input: VcsCreateReferenceInput,
  ) => Effect.Effect<VcsCreateReferenceResult, ProjectVcsServiceError>;
  readonly switchReference: (
    input: VcsSwitchReferenceInput,
  ) => Effect.Effect<VcsSwitchReferenceResult, ProjectVcsServiceError>;
  readonly listWorkspaces: (
    input: VcsListWorkspacesInput,
  ) => Effect.Effect<VcsListWorkspacesResult, ProjectVcsServiceError>;
  readonly createWorkspace: (
    input: VcsCreateWorkspaceInput,
  ) => Effect.Effect<VcsCreateWorkspaceResult, ProjectVcsServiceError>;
  readonly removeWorkspace: (
    input: VcsRemoveWorkspaceInput,
  ) => Effect.Effect<VcsRemoveWorkspaceResult, ProjectVcsServiceError>;
  readonly handoffThread: (
    input: VcsHandoffThreadInput,
  ) => Effect.Effect<VcsHandoffThreadResult, ProjectVcsServiceError>;
  readonly pull: (
    input: VcsPullInput,
  ) => Effect.Effect<VcsPullResult, ProjectVcsServiceError>;
  readonly githubRepository: (
    input: VcsGitHubRepositoryInput,
  ) => Effect.Effect<VcsGitHubRepositoryResult, ProjectVcsServiceError>;
  /**
   * Resolve the cwd used only by Git/GitHub remote fallbacks. For JJ this is
   * the repository's Git backing store, never the JJ working copy.
   */
  readonly remoteGitCwd: (
    input: VcsGitHubRepositoryInput,
  ) => Effect.Effect<string, ProjectVcsServiceError>;
  readonly resolvePullRequest: (
    input: VcsResolvePullRequestInput,
  ) => Effect.Effect<VcsResolvePullRequestResult, ProjectVcsServiceError>;
  /** Materialize a remote PR head without switching or creating a workspace. */
  readonly materializePullRequestHead: (
    input: VcsResolvePullRequestInput,
  ) => Effect.Effect<MaterializedPullRequestHead, ProjectVcsServiceError>;
  readonly pullRequestSnapshot: (
    input: VcsPullRequestSnapshotInput,
  ) => Effect.Effect<VcsPullRequestSnapshotResult, ProjectVcsServiceError>;
  readonly preparePullRequestThread: (
    input: VcsPreparePullRequestThreadInput,
  ) => Effect.Effect<VcsPreparePullRequestThreadResult, ProjectVcsServiceError>;
  readonly runStackedAction: (
    input: VcsRunStackedActionInput,
    options?: {
      readonly publishProgress?: (
        event: GitActionProgressEvent,
      ) => Effect.Effect<void>;
    },
  ) => Effect.Effect<GitRunStackedActionResult, ProjectVcsServiceError>;
}

export class ProjectVcs extends ServiceMap.Service<ProjectVcs, ProjectVcsShape>()(
  "synara/vcs/Services/ProjectVcs",
) {}
