import * as Crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  CommandId,
  type OrchestrationProjectShell,
  type ProjectVcsBinding,
  type VcsBackend,
  type VcsFileChange,
  type VcsListReferencesResult,
  type VcsListWorkspacesResult,
  type VcsStatusResult,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectVcsError } from "../Errors.ts";
import { JjCore, type JjCoreShape } from "../Services/JjCore.ts";
import {
  ProjectVcs,
  type ProjectVcsShape,
  type ResolvedProjectVcsTarget,
} from "../Services/ProjectVcs.ts";

export interface ProjectVcsDependencies {
  readonly git: GitCoreShape;
  readonly gitManager: GitManagerShape;
  readonly jj: JjCoreShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projection: ProjectionSnapshotQueryShape;
  readonly canonicalizePath: (path: string) => Promise<string>;
  readonly now: () => string;
  readonly makeCommandId: () => CommandId;
}

const DEFAULT_REFERENCE_NAMES = ["main", "master", "trunk", "develop", "default"] as const;

const capabilitiesFor = (backend: VcsBackend) => ({
  staging: backend === "git",
  stash: backend === "git",
  checkout: backend === "git",
  workspaces: true,
});

function bindingEquals(left: ProjectVcsBinding, right: ProjectVcsBinding): boolean {
  return (
    left.backend === right.backend &&
    left.repoRoot === right.repoRoot &&
    left.projectRelativePath === right.projectRelativePath
  );
}

function projectError(
  operation: string,
  reason: ConstructorParameters<typeof ProjectVcsError>[0]["reason"],
  detail: string,
) {
  return new ProjectVcsError({ operation, reason, detail });
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate);
  return relative === "" || (!nodePath.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${nodePath.sep}`));
}

function projectPathForBinding(binding: ProjectVcsBinding): string {
  return binding.projectRelativePath === "."
    ? binding.repoRoot
    : nodePath.join(binding.repoRoot, binding.projectRelativePath);
}

function workspaceProjectPath(
  workspaceRoot: string,
  binding: ProjectVcsBinding,
): string {
  return binding.projectRelativePath === "."
    ? workspaceRoot
    : nodePath.join(workspaceRoot, binding.projectRelativePath);
}

function chooseDefaultReference(names: ReadonlyArray<string>): string | null {
  const nameSet = new Set(names);
  return DEFAULT_REFERENCE_NAMES.find((name) => nameSet.has(name)) ?? names[0] ?? null;
}

export function makeProjectVcsWith(dependencies: ProjectVcsDependencies): ProjectVcsShape {
  const readProject = (operation: string, projectId: Parameters<ProjectVcsShape["setBackend"]>[0]["projectId"]) =>
    dependencies.projection.getProjectShellById(projectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              projectError(
                operation,
                "project-not-found",
                `Project '${projectId}' does not exist or is deleted.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const canonicalize = (operation: string, path: string) =>
    Effect.tryPromise({
      try: () => dependencies.canonicalizePath(path),
      catch: () =>
        projectError(
          operation,
          "repository-not-found",
          "The project workspace path does not exist or cannot be resolved.",
        ),
    });

  const detectBinding = (
    operation: string,
    backend: VcsBackend,
    projectRoot: string,
  ): Effect.Effect<ProjectVcsBinding, ProjectVcsError | import("../Errors.ts").JjCommandError | import("../../git/Errors.ts").GitCommandError> =>
    Effect.gen(function* () {
      const canonicalProjectRoot = yield* canonicalize(operation, projectRoot);
      const repoRoot =
        backend === "jj"
          ? yield* dependencies.jj.detectRepository(canonicalProjectRoot).pipe(
              Effect.flatMap((repository) =>
                repository
                  ? Effect.succeed(repository.workspaceRoot)
                  : Effect.fail(
                      projectError(
                        operation,
                        "repository-not-found",
                        "The project is not inside a JJ workspace.",
                      ),
                    ),
              ),
            )
          : yield* dependencies.git
              .execute({
                operation: "ProjectVcs.detectGitRepository",
                cwd: canonicalProjectRoot,
                args: ["rev-parse", "--show-toplevel"],
                allowNonZeroExit: true,
              })
              .pipe(
                Effect.flatMap((result) =>
                  result.code === 0 && result.stdout.trim().length > 0
                    ? canonicalize(operation, result.stdout.trim())
                    : Effect.fail(
                        projectError(
                          operation,
                          "repository-not-found",
                          "The project is not inside a Git worktree.",
                        ),
                      ),
                ),
              );
      if (!isPathInside(repoRoot, canonicalProjectRoot)) {
        return yield* projectError(
          operation,
          "stale-binding",
          "The detected repository root does not contain the project workspace.",
        );
      }
      const relative = nodePath.relative(repoRoot, canonicalProjectRoot);
      return {
        backend,
        repoRoot,
        projectRelativePath: relative.length === 0 ? "." : relative,
      };
    });

  const setBackend: ProjectVcsShape["setBackend"] = (input) =>
    Effect.gen(function* () {
      const operation = "ProjectVcs.setBackend";
      const project = yield* readProject(operation, input.projectId);
      if ((project.kind ?? "project") !== "project") {
        return yield* projectError(
          operation,
          "project-kind-unsupported",
          "Only ordinary projects can configure a VCS backend.",
        );
      }
      if (project.vcs.epoch !== input.expectedEpoch) {
        return yield* projectError(
          operation,
          "epoch-mismatch",
          `The VCS backend changed from epoch ${input.expectedEpoch} to ${project.vcs.epoch}; refresh and retry.`,
        );
      }

      const binding = yield* detectBinding(operation, input.backend, project.workspaceRoot);
      if (project.vcs.binding && bindingEquals(project.vcs.binding, binding)) {
        return { vcs: project.vcs };
      }

      const changesBackend =
        project.vcs.binding !== null && project.vcs.binding.backend !== input.backend;
      const initializesJj = project.vcs.binding === null && input.backend === "jj";
      if (changesBackend || initializesJj) {
        const snapshot = yield* dependencies.projection.getShellSnapshot();
        const blockingThreadIds = snapshot.threads
          .filter(
            (thread) =>
              thread.projectId === input.projectId && thread.worktreePath !== null,
          )
          .map((thread) => thread.id);
        if (blockingThreadIds.length > 0) {
          return yield* projectError(
            operation,
            "backend-switch-blocked",
            `Move or remove ${blockingThreadIds.length} existing worktree thread(s) before changing this project to ${input.backend}.`,
          );
        }
      }

      yield* dependencies.orchestrationEngine.dispatch({
        type: "project.vcs-binding.set",
        commandId: dependencies.makeCommandId(),
        projectId: input.projectId,
        expectedEpoch: input.expectedEpoch,
        binding,
        updatedAt: dependencies.now(),
      });
      return {
        vcs: {
          epoch: input.expectedEpoch + 1,
          binding,
        },
      };
    });

  const validateBindingRoot = (
    operation: string,
    project: OrchestrationProjectShell,
    binding: ProjectVcsBinding,
  ) =>
    Effect.gen(function* () {
      const [actualRoot, boundRoot] = yield* Effect.all(
        [
          canonicalize(operation, project.workspaceRoot),
          canonicalize(operation, projectPathForBinding(binding)),
        ],
        { concurrency: 2 },
      );
      if (actualRoot !== boundRoot) {
        return yield* projectError(
          operation,
          "stale-binding",
          "The project workspace changed after its VCS backend was configured; configure the backend again.",
        );
      }
      return boundRoot;
    });

  const resolveTarget: ProjectVcsShape["resolveTarget"] = (input) =>
    Effect.gen(function* () {
      const operation = "ProjectVcs.resolveTarget";
      const project = yield* readProject(operation, input.projectId);
      if (project.vcs.epoch !== input.expectedEpoch) {
        return yield* projectError(
          operation,
          "epoch-mismatch",
          `The VCS backend changed from epoch ${input.expectedEpoch} to ${project.vcs.epoch}; refresh and retry.`,
        );
      }
      const binding = project.vcs.binding;
      if (!binding) {
        return yield* projectError(
          operation,
          "backend-unconfigured",
          "Choose Git or JJ for this project before using source control.",
        );
      }
      const projectCwd = yield* validateBindingRoot(operation, project, binding);
      if (!input.threadId) {
        return {
          projectId: input.projectId,
          threadId: null,
          backend: binding.backend,
          epoch: project.vcs.epoch,
          binding,
          cwd: projectCwd,
        } satisfies ResolvedProjectVcsTarget;
      }

      const thread = yield* dependencies.projection.getThreadShellById(input.threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                projectError(
                  operation,
                  "thread-not-found",
                  `Thread '${input.threadId}' does not exist or is deleted.`,
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (thread.projectId !== input.projectId) {
        return yield* projectError(
          operation,
          "thread-project-mismatch",
          "The requested thread does not belong to the requested project.",
        );
      }
      if (thread.envMode === "worktree" && thread.worktreePath === null) {
        return yield* projectError(
          operation,
          "thread-not-found",
          "The thread workspace has not been materialized yet.",
        );
      }
      return {
        projectId: input.projectId,
        threadId: input.threadId,
        backend: binding.backend,
        epoch: project.vcs.epoch,
        binding,
        cwd:
          thread.envMode === "worktree" && thread.worktreePath
            ? thread.worktreePath
            : projectCwd,
      } satisfies ResolvedProjectVcsTarget;
    });

  const status: ProjectVcsShape["status"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        target.backend === "git"
          ? dependencies.gitManager.status({ cwd: target.cwd }).pipe(
              Effect.map(
                (result): VcsStatusResult => ({
                  backend: "git",
                  epoch: target.epoch,
                  ref: result.branch,
                  revision: null,
                  hasChanges: result.hasWorkingTreeChanges,
                  hasConflicts: false,
                  files: result.workingTree.files.map(
                    (file): VcsFileChange => ({
                      path: file.path,
                      sourcePath: null,
                      status: "unknown",
                      conflicted: false,
                      insertions: file.insertions,
                      deletions: file.deletions,
                    }),
                  ),
                  insertions: result.workingTree.insertions,
                  deletions: result.workingTree.deletions,
                  remote:
                    result.hasUpstream && result.upstreamBranch
                      ? {
                          ref: result.upstreamBranch,
                          aheadCount: result.aheadCount,
                          behindCount: result.behindCount,
                        }
                      : null,
                  capabilities: capabilitiesFor("git"),
                }),
              ),
            )
          : dependencies.jj.status(target.cwd).pipe(
              Effect.map(
                (result): VcsStatusResult => ({
                  backend: "jj",
                  epoch: target.epoch,
                  ref: result.currentBookmark,
                  revision: result.revision,
                  hasChanges: result.hasChanges,
                  hasConflicts: result.hasConflicts,
                  files: result.files.map(
                    (file): VcsFileChange => ({
                      path: file.path,
                      sourcePath: file.sourcePath === file.path ? null : file.sourcePath,
                      status: file.status,
                      conflicted: file.conflicted,
                      insertions: 0,
                      deletions: 0,
                    }),
                  ),
                  insertions: 0,
                  deletions: 0,
                  remote: result.upstreamBookmark
                    ? {
                        ref: result.upstreamBookmark,
                        aheadCount: result.aheadCount,
                        behindCount: result.behindCount,
                      }
                    : null,
                  capabilities: capabilitiesFor("jj"),
                }),
              ),
            ),
      ),
    );

  const readDiff: ProjectVcsShape["readDiff"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.gitManager
            .readWorkingTreeDiff({ cwd: target.cwd, scope: input.scope })
            .pipe(
              Effect.map((result) => ({
                backend: "git" as const,
                epoch: target.epoch,
                patch: result.patch,
              })),
            );
        }
        if (input.scope === "staged") {
          return Effect.fail(
            projectError(
              "ProjectVcs.readDiff",
              "operation-unsupported",
              "JJ has no staging area; use the working-copy diff.",
            ),
          );
        }
        if (input.scope === "branch") {
          return dependencies.jj.status(target.cwd).pipe(
            Effect.flatMap((jjStatus) =>
              dependencies.jj.readRangeDiff(
                target.cwd,
                jjStatus.upstreamBookmark ?? jjStatus.currentBookmark ?? "@-",
                "@",
              ),
            ),
            Effect.map((result) => ({
              backend: "jj" as const,
              epoch: target.epoch,
              patch: result.patch,
            })),
          );
        }
        return dependencies.jj.readRevisionDiff(target.cwd, "@").pipe(
          Effect.map((result) => ({
            backend: "jj" as const,
            epoch: target.epoch,
            patch: result.patch,
          })),
        );
      }),
    );

  const listJjWorkspacePaths = (
    target: ResolvedProjectVcsTarget,
  ): Effect.Effect<
    Map<string, string>,
    import("../Errors.ts").JjCommandError
  > =>
    dependencies.jj.listWorkspaces(target.binding.repoRoot).pipe(
      Effect.map((workspaces) => {
        const paths = new Map<string, string>();
        for (const workspace of workspaces) {
          if (workspace.registration.kind === "present") {
            paths.set(
              workspace.name,
              workspaceProjectPath(workspace.registration.root, target.binding),
            );
          }
        }
        return paths;
      }),
    );

  const listReferences: ProjectVcsShape["listReferences"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.git.listBranches({ cwd: target.cwd }).pipe(
            Effect.map(
              (result): VcsListReferencesResult => ({
                backend: "git",
                epoch: target.epoch,
                references: result.branches.map((branch) => ({
                  name: branch.name,
                  kind: "branch",
                  isRemote: branch.isRemote === true,
                  remoteName: branch.remoteName ?? null,
                  current: branch.current,
                  isDefault: branch.isDefault,
                  workspacePath: branch.worktreePath,
                  conflicted: false,
                  tracked: false,
                  synced: false,
                })),
                hasOriginRemote: result.hasOriginRemote,
              }),
            ),
          );
        }

        return Effect.all(
          [dependencies.jj.status(target.cwd), listJjWorkspacePaths(target)],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([jjStatus, workspacePaths]): VcsListReferencesResult => {
            const localNames = jjStatus.bookmarks
              .filter((bookmark) => bookmark.isLocal)
              .map((bookmark) => bookmark.name)
              .toSorted((left, right) => left.localeCompare(right));
            const defaultName = chooseDefaultReference(localNames);
            const references = jjStatus.bookmarks.flatMap((bookmark) => {
              const localReference = bookmark.isLocal
                ? [
                    {
                      name: bookmark.name,
                      kind: "bookmark" as const,
                      isRemote: false,
                      remoteName: null,
                      current: bookmark.name === jjStatus.currentBookmark,
                      isDefault: bookmark.name === defaultName,
                      workspacePath: workspacePaths.get(bookmark.name) ?? null,
                      conflicted: bookmark.conflicted,
                      tracked: bookmark.remotes.some((remote) => remote.tracked),
                      synced:
                        bookmark.remotes.length > 0 &&
                        bookmark.remotes.every((remote) => remote.synced),
                    },
                  ]
                : [];
              const remoteReferences = bookmark.remotes.map((remote) => ({
                name: `${bookmark.name}@${remote.name}`,
                kind: "bookmark" as const,
                isRemote: true,
                remoteName: remote.name,
                current: false,
                isDefault: false,
                workspacePath: null,
                conflicted: bookmark.conflicted,
                tracked: remote.tracked,
                synced: remote.synced,
              }));
              return [...localReference, ...remoteReferences];
            });
            return {
              backend: "jj",
              epoch: target.epoch,
              references,
              hasOriginRemote: jjStatus.bookmarks.some((bookmark) =>
                bookmark.remotes.some((remote) => remote.name === "origin"),
              ),
            };
          }),
        );
      }),
    );

  const listWorkspaces: ProjectVcsShape["listWorkspaces"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.git.listBranches({ cwd: target.cwd }).pipe(
            Effect.map((result): VcsListWorkspacesResult => {
              const seenPaths = new Set<string>();
              const workspaces = result.branches.flatMap((branch) => {
                if (!branch.worktreePath || seenPaths.has(branch.worktreePath)) {
                  return [];
                }
                seenPaths.add(branch.worktreePath);
                return [
                  {
                    name: branch.name,
                    path: branch.worktreePath,
                    stale: false,
                    current: nodePath.resolve(branch.worktreePath) === nodePath.resolve(target.cwd),
                    ref: branch.name,
                  },
                ];
              });
              return {
                backend: "git",
                epoch: target.epoch,
                workspaces,
              };
            }),
          );
        }
        return dependencies.jj.listWorkspaces(target.binding.repoRoot).pipe(
          Effect.map(
            (workspaces): VcsListWorkspacesResult => ({
              backend: "jj",
              epoch: target.epoch,
              workspaces: workspaces.map((workspace) => {
                const path =
                  workspace.registration.kind === "present"
                    ? workspaceProjectPath(workspace.registration.root, target.binding)
                    : null;
                return {
                  name: workspace.name,
                  path,
                  stale: workspace.registration.kind === "stale",
                  current:
                    path !== null && nodePath.resolve(path) === nodePath.resolve(target.cwd),
                  ref: null,
                };
              }),
            }),
          ),
        );
      }),
    );

  return {
    setBackend,
    resolveTarget,
    status,
    readDiff,
    listReferences,
    listWorkspaces,
  };
}

export const makeProjectVcs = Effect.gen(function* () {
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const jj = yield* JjCore;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  return makeProjectVcsWith({
    git,
    gitManager,
    jj,
    orchestrationEngine,
    projection,
    canonicalizePath: nodeFs.realpath,
    now: () => new Date().toISOString(),
    makeCommandId: () =>
      CommandId.makeUnsafe(`server:vcs-binding:${Crypto.randomUUID()}`),
  });
});

export const ProjectVcsLive = Layer.effect(ProjectVcs, makeProjectVcs);
