import * as nodePath from "node:path";

import { WS_METHODS, WsRpcError, type VcsBackend } from "@synara/contracts";
import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";

/**
 * These calls use Git/GitHub only to discover remote identity or read hosted
 * pull-request metadata. They do not inspect or mutate the local Git working
 * copy and are the complete Git fallback allowlist for a JJ-bound project.
 */
const JJ_GIT_REMOTE_READ_ALLOWLIST = new Set<string>([
  WS_METHODS.gitGithubRepository,
  WS_METHODS.gitResolvePullRequest,
  WS_METHODS.gitPullRequestSnapshot,
]);

function isPathInside(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!nodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${nodePath.sep}`))
  );
}

function workspaceRootForProjectPath(
  projectPath: string,
  projectRelativePath: string,
): string | null {
  if (projectRelativePath === ".") {
    return nodePath.resolve(projectPath);
  }
  const depth = projectRelativePath.split(/[\\/]/u).filter(Boolean).length;
  const workspaceRoot = nodePath.resolve(
    projectPath,
    ...Array.from({ length: depth }, () => ".."),
  );
  return nodePath.resolve(workspaceRoot, projectRelativePath) === nodePath.resolve(projectPath)
    ? workspaceRoot
    : null;
}

export interface LegacyGitBackendBoundaryDependencies {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly getVcsBackend: Effect.Effect<VcsBackend, unknown>;
  readonly canonicalizePath: (path: string) => Effect.Effect<string>;
  readonly resolveJjGitStorePath: (
    cwd: string,
  ) => Effect.Effect<string | null>;
}

export interface LegacyGitBackendBoundaryInput {
  readonly method: string;
  readonly cwd: string;
}

/**
 * Prevent cwd-based legacy Git RPCs from bypassing a project's exclusive JJ
 * backend. Unknown legacy Git methods default to local access and are blocked;
 * only the explicit remote-read allowlist above can cross the boundary.
 */
export function makeLegacyGitBackendBoundary(
  dependencies: LegacyGitBackendBoundaryDependencies,
) {
  return (input: LegacyGitBackendBoundaryInput) => {
    if (JJ_GIT_REMOTE_READ_ALLOWLIST.has(input.method)) {
      return Effect.void;
    }

    return Effect.gen(function* () {
      if ((yield* dependencies.getVcsBackend) !== "jj") {
        return;
      }
      const [cwd, snapshot] = yield* Effect.all(
        [
          dependencies.canonicalizePath(input.cwd),
          dependencies.snapshotQuery.getShellSnapshot(),
        ],
        { concurrency: 2 },
      );
      const jjRoots: Array<{ readonly projectId: string; readonly root: string }> = [];
      const jjRepositoryRoots: Array<{
        readonly projectId: string;
        readonly root: string;
      }> = [];

      for (const project of snapshot.projects) {
        if ((project.kind ?? "project") !== "project") continue;
        jjRoots.push({ projectId: project.id, root: project.workspaceRoot });
        const binding = project.vcs.binding;
        if (binding?.backend !== "jj") continue;
        jjRoots.push({ projectId: project.id, root: binding.repoRoot });
        jjRepositoryRoots.push({
          projectId: project.id,
          root: binding.repoRoot,
        });

        for (const thread of snapshot.threads) {
          if (thread.projectId !== project.id) continue;
          const projectPaths = new Set(
            [thread.worktreePath, thread.associatedWorktreePath].filter(
              (path): path is string => path !== null,
            ),
          );
          for (const projectPath of projectPaths) {
            const workspaceRoot = workspaceRootForProjectPath(
              projectPath,
              binding.projectRelativePath,
            );
            if (workspaceRoot) {
              jjRoots.push({ projectId: project.id, root: workspaceRoot });
            }
          }
        }
      }

      const gitStoreRoots = yield* Effect.forEach(
        jjRepositoryRoots,
        (entry) =>
          dependencies
            .resolveJjGitStorePath(entry.root)
            .pipe(
              Effect.map((root) =>
                root === null ? null : { ...entry, root },
              ),
              // The bound workspace root remains protected even when a stale
              // repository cannot currently reveal its external Git store.
              Effect.catch(() => Effect.succeed(null)),
            ),
        { concurrency: 4 },
      );
      const canonicalRoots = yield* Effect.forEach(
        [
          ...jjRoots,
          ...gitStoreRoots.filter(
            (
              entry,
            ): entry is {
              readonly projectId: string;
              readonly root: string;
            } => entry !== null,
          ),
        ],
        (entry) =>
          dependencies
            .canonicalizePath(entry.root)
            .pipe(Effect.map((root) => ({ ...entry, root }))),
        { concurrency: 8 },
      );
      const match = canonicalRoots.find((entry) => isPathInside(entry.root, cwd));
      if (!match) return;

      return yield* Effect.fail(
        new WsRpcError({
          code: "VCS_BACKEND_MISMATCH",
          message:
            `The global backend is JJ. ${input.method} cannot read or mutate project '${match.projectId}' through ` +
            "local Git state; use the project-scoped VCS API instead.",
        }),
      );
    });
  };
}
