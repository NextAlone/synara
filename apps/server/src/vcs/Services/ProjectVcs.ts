import type {
  ProjectId,
  ProjectVcsBinding,
  ThreadId,
  VcsBackend,
  VcsCreateReferenceInput,
  VcsCreateReferenceResult,
  VcsCreateWorkspaceInput,
  VcsCreateWorkspaceResult,
  VcsHandoffThreadInput,
  VcsHandoffThreadResult,
  VcsListReferencesInput,
  VcsListReferencesResult,
  VcsListWorkspacesInput,
  VcsListWorkspacesResult,
  VcsReadDiffInput,
  VcsReadDiffResult,
  VcsRemoveWorkspaceInput,
  VcsRemoveWorkspaceResult,
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
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { JjCommandError, ProjectVcsError } from "../Errors.ts";

export type ProjectVcsServiceError =
  | ProjectVcsError
  | JjCommandError
  | GitManagerServiceError
  | ProjectionRepositoryError
  | OrchestrationDispatchError;

export interface ResolvedProjectVcsTarget {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId | null;
  readonly backend: VcsBackend;
  readonly epoch: number;
  readonly binding: ProjectVcsBinding;
  /** Server-derived project cwd in the selected local/workspace checkout. */
  readonly cwd: string;
}

export interface ProjectVcsShape {
  readonly setBackend: (
    input: VcsSetBackendInput,
  ) => Effect.Effect<VcsSetBackendResult, ProjectVcsServiceError>;
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
}

export class ProjectVcs extends ServiceMap.Service<ProjectVcs, ProjectVcsShape>()(
  "synara/vcs/Services/ProjectVcs",
) {}
