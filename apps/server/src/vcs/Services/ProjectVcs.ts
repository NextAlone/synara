import type {
  ProjectId,
  ProjectVcsBinding,
  ThreadId,
  VcsBackend,
  VcsListReferencesInput,
  VcsListReferencesResult,
  VcsListWorkspacesInput,
  VcsListWorkspacesResult,
  VcsReadDiffInput,
  VcsReadDiffResult,
  VcsSetBackendInput,
  VcsSetBackendResult,
  VcsStatusInput,
  VcsStatusResult,
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
  readonly listWorkspaces: (
    input: VcsListWorkspacesInput,
  ) => Effect.Effect<VcsListWorkspacesResult, ProjectVcsServiceError>;
}

export class ProjectVcs extends ServiceMap.Service<ProjectVcs, ProjectVcsShape>()(
  "synara/vcs/Services/ProjectVcs",
) {}
