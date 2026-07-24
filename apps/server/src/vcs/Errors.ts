import { Schema } from "effect";

/**
 * A typed boundary error for invoking JJ or decoding its machine output.
 */
export class JjCommandError extends Schema.TaggedErrorClass<JjCommandError>()("JjCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `JJ command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}

export const ProjectVcsErrorReason = Schema.Literals([
  "project-not-found",
  "project-kind-unsupported",
  "thread-not-found",
  "thread-project-mismatch",
  "backend-unconfigured",
  "epoch-mismatch",
  "repository-not-found",
  "stale-binding",
  "backend-switch-blocked",
  "workspace-not-found",
  "workspace-dirty",
  "operation-unsupported",
]);
export type ProjectVcsErrorReason = typeof ProjectVcsErrorReason.Type;

/** A project-aware VCS request failed before a backend command was dispatched. */
export class ProjectVcsError extends Schema.TaggedErrorClass<ProjectVcsError>()(
  "ProjectVcsError",
  {
    operation: Schema.String,
    reason: ProjectVcsErrorReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Project VCS failed in ${this.operation}: ${this.detail}`;
  }
}
