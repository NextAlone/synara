import type { ProjectVcsState } from "@synara/contracts";

const EMPTY_PROJECT_VCS_STATE: ProjectVcsState = {
  epoch: 0,
  binding: null,
};

/**
 * Older projected snapshots predate project-scoped VCS state. Normalize that
 * compatibility shape once at each server boundary before making VCS decisions.
 */
export function resolveProjectVcsState(project: {
  readonly vcs?: ProjectVcsState | undefined;
}): ProjectVcsState {
  return project.vcs ?? EMPTY_PROJECT_VCS_STATE;
}
