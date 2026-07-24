import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

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

