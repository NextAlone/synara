import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";
import {
  GitHubRepositoryResult,
  GitPullRequestCheck,
  GitPullRequestComment,
} from "./git";
import {
  VcsBackend,
  VcsProjectTarget,
  VcsPullRequestStatus,
} from "./vcs";

const VcsPullRequestReference = TrimmedNonEmptyString;

export const VcsGitHubRepositoryInput = VcsProjectTarget;
export type VcsGitHubRepositoryInput =
  typeof VcsGitHubRepositoryInput.Type;

export const VcsGitHubRepositoryResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  ...GitHubRepositoryResult.fields,
});
export type VcsGitHubRepositoryResult =
  typeof VcsGitHubRepositoryResult.Type;

export const VcsResolvePullRequestInput = Schema.Struct({
  ...VcsProjectTarget.fields,
  reference: VcsPullRequestReference,
});
export type VcsResolvePullRequestInput =
  typeof VcsResolvePullRequestInput.Type;

export const VcsResolvePullRequestResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  pullRequest: VcsPullRequestStatus,
});
export type VcsResolvePullRequestResult =
  typeof VcsResolvePullRequestResult.Type;

export const VcsPullRequestSnapshotInput = VcsResolvePullRequestInput;
export type VcsPullRequestSnapshotInput =
  typeof VcsPullRequestSnapshotInput.Type;

export const VcsPullRequestSnapshotResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  pullRequest: VcsPullRequestStatus,
  checks: Schema.Array(GitPullRequestCheck),
  comments: Schema.Array(GitPullRequestComment),
  commentsTruncated: Schema.Boolean,
  commentsError: Schema.NullOr(Schema.String),
});
export type VcsPullRequestSnapshotResult =
  typeof VcsPullRequestSnapshotResult.Type;

export const VcsPreparePullRequestThreadInput = Schema.Struct({
  ...VcsProjectTarget.fields,
  reference: VcsPullRequestReference,
  mode: Schema.Literals(["local", "worktree"]),
});
export type VcsPreparePullRequestThreadInput =
  typeof VcsPreparePullRequestThreadInput.Type;

export const VcsPreparePullRequestThreadResult = Schema.Struct({
  backend: VcsBackend,
  epoch: NonNegativeInt,
  pullRequest: VcsPullRequestStatus,
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
});
export type VcsPreparePullRequestThreadResult =
  typeof VcsPreparePullRequestThreadResult.Type;
