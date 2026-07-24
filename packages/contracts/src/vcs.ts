import { Schema } from "effect";

import {
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const VcsBackend = Schema.Literals(["git", "jj"]);
export type VcsBackend = typeof VcsBackend.Type;

/**
 * Persisted repository identity for one project.
 *
 * `projectRelativePath` is "." when the project root is the repository root.
 * Keeping it explicit lets isolated workspaces reconstruct a thread cwd without
 * assuming every Synara project owns an entire repository.
 */
export const ProjectVcsBinding = Schema.Struct({
  backend: VcsBackend,
  repoRoot: TrimmedNonEmptyString,
  projectRelativePath: TrimmedNonEmptyString,
});
export type ProjectVcsBinding = typeof ProjectVcsBinding.Type;

/**
 * Project-scoped VCS state.
 *
 * The epoch remains present when `binding` is null so a backend removal still
 * invalidates in-flight status, diff, and workspace requests.
 */
export const ProjectVcsState = Schema.Struct({
  epoch: NonNegativeInt,
  binding: Schema.NullOr(ProjectVcsBinding),
});
export type ProjectVcsState = typeof ProjectVcsState.Type;

/**
 * Project-scoped VCS requests never accept an arbitrary cwd. The server derives
 * it from the persisted project/thread projection and rejects stale epochs.
 */
export const VcsProjectTarget = Schema.Struct({
  projectId: ProjectId,
  threadId: Schema.optional(ThreadId),
  expectedEpoch: NonNegativeInt,
});
export type VcsProjectTarget = typeof VcsProjectTarget.Type;

export const VcsSetBackendInput = Schema.Struct({
  projectId: ProjectId,
  backend: VcsBackend,
  expectedEpoch: NonNegativeInt,
});
export type VcsSetBackendInput = typeof VcsSetBackendInput.Type;

export const VcsSetBackendResult = Schema.Struct({
  vcs: ProjectVcsState,
});
export type VcsSetBackendResult = typeof VcsSetBackendResult.Type;

export const VcsFileChangeStatus = Schema.Literals([
  "modified",
  "added",
  "removed",
  "copied",
  "renamed",
  "unknown",
]);
export type VcsFileChangeStatus = typeof VcsFileChangeStatus.Type;

export const VcsFileChange = Schema.Struct({
  path: TrimmedNonEmptyString,
  sourcePath: Schema.NullOr(TrimmedNonEmptyString),
  status: VcsFileChangeStatus,
  conflicted: Schema.Boolean,
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type VcsFileChange = typeof VcsFileChange.Type;

export const VcsRevision = Schema.Struct({
  changeId: TrimmedNonEmptyString,
  commitId: TrimmedNonEmptyString,
  description: Schema.String,
});
export type VcsRevision = typeof VcsRevision.Type;

export const VcsRemoteStatus = Schema.Struct({
  ref: TrimmedNonEmptyString,
  aheadCount: NonNegativeInt,
  behindCount: NonNegativeInt,
});
export type VcsRemoteStatus = typeof VcsRemoteStatus.Type;

export const VcsCapabilities = Schema.Struct({
  staging: Schema.Boolean,
  stash: Schema.Boolean,
  checkout: Schema.Boolean,
  workspaces: Schema.Boolean,
});
export type VcsCapabilities = typeof VcsCapabilities.Type;

export const VcsStatusInput = VcsProjectTarget;
export type VcsStatusInput = typeof VcsStatusInput.Type;

export const VcsStatusResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  ref: Schema.NullOr(TrimmedNonEmptyString),
  revision: Schema.NullOr(VcsRevision),
  hasChanges: Schema.Boolean,
  hasConflicts: Schema.Boolean,
  files: Schema.Array(VcsFileChange),
  insertions: NonNegativeInt,
  deletions: NonNegativeInt,
  remote: Schema.NullOr(VcsRemoteStatus),
  capabilities: VcsCapabilities,
});
export type VcsStatusResult = typeof VcsStatusResult.Type;

export const VcsDiffScope = Schema.Literals([
  "workingTree",
  "unstaged",
  "staged",
  "branch",
]);
export type VcsDiffScope = typeof VcsDiffScope.Type;

export const VcsReadDiffInput = Schema.Struct({
  ...VcsProjectTarget.fields,
  scope: VcsDiffScope,
});
export type VcsReadDiffInput = typeof VcsReadDiffInput.Type;

export const VcsReadDiffResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  patch: Schema.String,
});
export type VcsReadDiffResult = typeof VcsReadDiffResult.Type;

export const VcsReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["branch", "bookmark"]),
  isRemote: Schema.Boolean,
  remoteName: Schema.NullOr(TrimmedNonEmptyString),
  current: Schema.Boolean,
  isDefault: Schema.Boolean,
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  conflicted: Schema.Boolean,
  tracked: Schema.Boolean,
  synced: Schema.Boolean,
});
export type VcsReference = typeof VcsReference.Type;

export const VcsListReferencesInput = VcsProjectTarget;
export type VcsListReferencesInput = typeof VcsListReferencesInput.Type;

export const VcsListReferencesResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  references: Schema.Array(VcsReference),
  hasOriginRemote: Schema.Boolean,
});
export type VcsListReferencesResult = typeof VcsListReferencesResult.Type;

export const VcsWorkspace = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  stale: Schema.Boolean,
  current: Schema.Boolean,
  ref: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsWorkspace = typeof VcsWorkspace.Type;

export const VcsListWorkspacesInput = VcsProjectTarget;
export type VcsListWorkspacesInput = typeof VcsListWorkspacesInput.Type;

export const VcsListWorkspacesResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  workspaces: Schema.Array(VcsWorkspace),
});
export type VcsListWorkspacesResult = typeof VcsListWorkspacesResult.Type;
