import * as Crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  CommandId,
  type OrchestrationProjectShell,
  type ProjectVcsBinding,
  type VcsBackend,
  type VcsFileChange,
  type VcsHandoffThreadResult,
  type VcsListReferencesResult,
  type VcsListWorkspacesResult,
  type VcsStatusResult,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { GitManager, type GitManagerShape } from "../../git/Services/GitManager.ts";
import {
  TextGeneration,
  type TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectVcsError } from "../Errors.ts";
import { makeJjActions } from "../jjActions.ts";
import { JjCore, type JjCoreShape } from "../Services/JjCore.ts";
import {
  ProjectVcs,
  type ProjectVcsShape,
  type ResolvedProjectVcsTarget,
} from "../Services/ProjectVcs.ts";

export interface ProjectVcsDependencies {
  readonly git: GitCoreShape;
  readonly gitManager: GitManagerShape;
  readonly gitHubCli: GitHubCliShape;
  readonly textGeneration: TextGenerationShape;
  readonly jj: JjCoreShape;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly projection: ProjectionSnapshotQueryShape;
  readonly canonicalizePath: (path: string) => Promise<string>;
  readonly now: () => string;
  readonly makeCommandId: () => CommandId;
  readonly worktreesDir: string;
  readonly pathExists: (path: string) => Promise<boolean>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
  readonly randomToken: () => string;
}

const DEFAULT_REFERENCE_NAMES = ["main", "master", "trunk", "develop", "default"] as const;

const capabilitiesFor = (backend: VcsBackend) => ({
  staging: backend === "git",
  stash: backend === "git",
  checkout: true,
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

function workspaceRootForProjectPath(
  projectPath: string,
  binding: ProjectVcsBinding,
): string | null {
  if (binding.projectRelativePath === ".") {
    return projectPath;
  }
  const depth = binding.projectRelativePath.split(/[\\/]/u).filter(Boolean).length;
  const workspaceRoot = nodePath.resolve(projectPath, ...Array.from({ length: depth }, () => ".."));
  return nodePath.resolve(workspaceProjectPath(workspaceRoot, binding)) === nodePath.resolve(projectPath)
    ? workspaceRoot
    : null;
}

function chooseDefaultReference(names: ReadonlyArray<string>): string | null {
  const nameSet = new Set(names);
  return DEFAULT_REFERENCE_NAMES.find((name) => nameSet.has(name)) ?? names[0] ?? null;
}

export function makeProjectVcsWith(dependencies: ProjectVcsDependencies): ProjectVcsShape {
  const jjActions = makeJjActions({
    jj: dependencies.jj,
    gitHubCli: dependencies.gitHubCli,
    textGeneration: dependencies.textGeneration,
  });
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
                  pullRequest: result.pr,
                  capabilities: capabilitiesFor("git"),
                }),
              ),
            )
          : Effect.gen(function* () {
              const result = yield* dependencies.jj.status(target.cwd);
              const pullRequest =
                result.currentBookmark && result.repository.gitStorePath
                  ? yield* dependencies.gitHubCli
                      .listOpenPullRequests({
                        cwd: result.repository.gitStorePath,
                        headSelector: result.currentBookmark,
                        limit: 10,
                      })
                      .pipe(
                        Effect.map((matches) => {
                          const match = matches[0];
                          return match
                            ? {
                                number: match.number,
                                title: match.title,
                                url: match.url,
                                baseBranch: match.baseRefName,
                                headBranch: match.headRefName,
                                state: match.state ?? ("open" as const),
                                isDraft: match.isDraft ?? false,
                                mergeability:
                                  match.mergeability ?? ("unknown" as const),
                                additions: match.additions ?? null,
                                deletions: match.deletions ?? null,
                                changedFiles: match.changedFiles ?? null,
                              }
                            : null;
                        }),
                        Effect.catch(() => Effect.succeed(null)),
                      )
                  : null;
              return {
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
                  pullRequest,
                  capabilities: capabilitiesFor("jj"),
                } satisfies VcsStatusResult;
            }),
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

  const createReference: ProjectVcsShape["createReference"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.git
            .createBranch({
              cwd: target.cwd,
              branch: input.name,
              ...(input.publish !== undefined ? { publish: input.publish } : {}),
            })
            .pipe(
              Effect.as({
                backend: "git" as const,
                epoch: target.epoch,
                ref: input.name,
              }),
            );
        }
        if (input.publish === true) {
          return Effect.fail(
            projectError(
              "ProjectVcs.createReference",
              "operation-unsupported",
              "Publishing a JJ bookmark is a remote operation and is not enabled yet.",
            ),
          );
        }
        return dependencies.jj.createBookmark(target.cwd, input.name, "@").pipe(
          Effect.as({
            backend: "jj" as const,
            epoch: target.epoch,
            ref: input.name,
          }),
        );
      }),
    );

  const switchReference: ProjectVcsShape["switchReference"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.git.checkout({ cwd: target.cwd, branch: input.ref }).pipe(
            Effect.andThen(
              dependencies.git.execute({
                operation: "ProjectVcs.switchReference.currentBranch",
                cwd: target.cwd,
                args: ["branch", "--show-current"],
              }),
            ),
            Effect.map((result) => ({
              backend: "git" as const,
              epoch: target.epoch,
              ref: result.stdout.trim() || null,
              revision: null,
            })),
          );
        }
        return dependencies.jj
          .startNewChange(target.cwd, input.ref, `wip: Synara on ${input.ref}`)
          .pipe(
            Effect.flatMap((revision) =>
              dependencies.jj.resolveNearestBookmark(target.cwd).pipe(
                Effect.map((ref) => ({
                  backend: "jj" as const,
                  epoch: target.epoch,
                  ref,
                  revision,
                })),
              ),
            ),
          );
      }),
    );

  const prepareGeneratedWorkspace = (operation: string) =>
    Effect.tryPromise({
      try: async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const token = dependencies.randomToken();
          const parent = nodePath.join(dependencies.worktreesDir, token);
          const root = nodePath.join(parent, "synara");
          if (await dependencies.pathExists(root)) {
            continue;
          }
          await dependencies.makeDirectory(parent);
          return { root, name: `synara-${token}` };
        }
        const token = dependencies.randomToken();
        const parent = nodePath.join(dependencies.worktreesDir, token);
        await dependencies.makeDirectory(parent);
        return { root: nodePath.join(parent, "synara"), name: `synara-${token}` };
      },
      catch: () =>
        projectError(
          operation,
          "workspace-not-found",
          "Failed to prepare a managed workspace path.",
        ),
    });

  const createWorkspace: ProjectVcsShape["createWorkspace"] = (input) =>
    resolveTarget({
      projectId: input.projectId,
      expectedEpoch: input.expectedEpoch,
    }).pipe(
      Effect.flatMap((target) =>
        Effect.gen(function* () {
          const operation = "ProjectVcs.createWorkspace";
          const generated =
            input.path === null ? yield* prepareGeneratedWorkspace(operation) : null;
          const requestedProjectPath = input.path;
          const requestedWorkspaceRoot =
            requestedProjectPath === null
              ? generated!.root
              : workspaceRootForProjectPath(requestedProjectPath, target.binding);
          if (!requestedWorkspaceRoot) {
            return yield* projectError(
              operation,
              "workspace-not-found",
              "The requested workspace path does not match the project's repository-relative path.",
            );
          }
          if (yield* Effect.promise(() => dependencies.pathExists(requestedWorkspaceRoot))) {
            return yield* projectError(
              operation,
              "workspace-not-found",
              "The requested workspace path already exists.",
            );
          }

          if (target.backend === "git") {
            const created = yield* dependencies.git.withMutation(
              target.cwd,
              dependencies.git.createDetachedWorktree({
                cwd: target.cwd,
                ref: input.sourceRef,
                path: requestedWorkspaceRoot,
                ...(input.copyChangesFromCurrent ? { copyChangesFrom: target.cwd } : {}),
              }),
            );
            const projectPath = workspaceProjectPath(created.worktree.path, target.binding);
            return {
              backend: "git",
              epoch: target.epoch,
              workspace: {
                name: created.worktree.branch ?? nodePath.basename(created.worktree.path),
                path: projectPath,
                ref: created.worktree.ref,
                branch: created.worktree.branch,
              },
            };
          }

          const workspaceName = generated?.name ?? `synara-${dependencies.randomToken()}`;
          const create = dependencies.jj
            .createWorkspace({
              repositoryPath: target.binding.repoRoot,
              workspacePath: requestedWorkspaceRoot,
              workspaceName,
              revision: input.copyChangesFromCurrent ? "@" : input.sourceRef,
              message: `wip: Synara workspace ${workspaceName}`,
            })
            .pipe(
              Effect.onError(() =>
                dependencies.jj
                  .getWorkspaceRegistration(target.binding.repoRoot, workspaceName)
                  .pipe(
                    Effect.flatMap((registration) =>
                      registration.kind === "absent"
                        ? Effect.void
                        : dependencies.jj.forgetWorkspace(
                            target.binding.repoRoot,
                            workspaceName,
                          ),
                    ),
                    Effect.andThen(
                      Effect.promise(() =>
                        dependencies.removeDirectory(requestedWorkspaceRoot),
                      ),
                    ),
                    Effect.ignore,
                  ),
              ),
            );
          const created = yield* create;
          return {
            backend: "jj",
            epoch: target.epoch,
            workspace: {
              name: created.name,
              path: workspaceProjectPath(created.path, target.binding),
              ref: created.revision.commitId,
              branch: null,
            },
          };
        }),
      ),
    );

  const removeWorkspace: ProjectVcsShape["removeWorkspace"] = (input) =>
    resolveTarget({
      projectId: input.projectId,
      expectedEpoch: input.expectedEpoch,
    }).pipe(
      Effect.flatMap((target) =>
        Effect.gen(function* () {
          const operation = "ProjectVcs.removeWorkspace";
          const requestedProjectPath = yield* canonicalize(operation, input.path);
          const requestedWorkspaceRoot = workspaceRootForProjectPath(
            requestedProjectPath,
            target.binding,
          );
          if (!requestedWorkspaceRoot) {
            return yield* projectError(
              operation,
              "workspace-not-found",
              "The requested path is not a workspace for this project.",
            );
          }

          if (target.backend === "git") {
            yield* dependencies.git.withMutation(
              target.cwd,
              dependencies.git.removeWorktree({
                cwd: target.cwd,
                path: requestedWorkspaceRoot,
                ...(input.force !== undefined ? { force: input.force } : {}),
              }),
            );
            return { backend: "git", epoch: target.epoch, removed: true };
          }

          const registrations = yield* dependencies.jj.listWorkspaces(
            target.binding.repoRoot,
          );
          const presentRegistrations = yield* Effect.forEach(
            registrations,
            (workspace) =>
              workspace.registration.kind !== "present"
                ? Effect.succeed(null)
                : canonicalize(operation, workspace.registration.root).pipe(
                    Effect.map((root) => ({ name: workspace.name, root })),
                  ),
            { concurrency: 4 },
          );
          const registered = presentRegistrations.find(
            (workspace) => workspace?.root === requestedWorkspaceRoot,
          );
          if (!registered || registered.root === target.binding.repoRoot) {
            return yield* projectError(
              operation,
              "workspace-not-found",
              "The requested path is not a removable JJ workspace for this project.",
            );
          }
          if (input.force !== true) {
            const workspaceStatus = yield* dependencies.jj.status(requestedProjectPath);
            if (workspaceStatus.hasChanges || workspaceStatus.hasConflicts) {
              return yield* projectError(
                operation,
                "workspace-dirty",
                "The JJ workspace has changes or conflicts; resolve them or request a forced removal.",
              );
            }
          }
          yield* dependencies.jj.forgetWorkspace(
            target.binding.repoRoot,
            registered.name,
          );
          yield* Effect.tryPromise({
            try: () => dependencies.removeDirectory(registered.root),
            catch: () =>
              projectError(
                operation,
                "workspace-not-found",
                "The JJ workspace was forgotten, but its directory could not be removed.",
              ),
          });
          return { backend: "jj", epoch: target.epoch, removed: true };
        }),
      ),
    );

  const handoffThread: ProjectVcsShape["handoffThread"] = (input) =>
    resolveTarget({
      projectId: input.projectId,
      threadId: input.threadId,
      expectedEpoch: input.expectedEpoch,
    }).pipe(
      Effect.flatMap((target) =>
        dependencies.projection.getThreadShellById(input.threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  projectError(
                    "ProjectVcs.handoffThread",
                    "thread-not-found",
                    `Thread '${input.threadId}' does not exist or is deleted.`,
                  ),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.flatMap((thread) =>
            Effect.gen(function* () {
              const primaryProjectCwd = projectPathForBinding(target.binding);
              if (target.backend === "git") {
                const toRepositoryWorkspacePath = (projectPath: string | null) =>
                  projectPath === null
                    ? null
                    : workspaceRootForProjectPath(projectPath, target.binding);
                const gitResult = yield* dependencies.gitManager.handoffThread({
                  cwd: primaryProjectCwd,
                  targetMode: input.targetMode,
                  currentBranch: thread.branch,
                  worktreePath: toRepositoryWorkspacePath(thread.worktreePath),
                  associatedWorktreePath: toRepositoryWorkspacePath(
                    thread.associatedWorktreePath ?? null,
                  ),
                  associatedWorktreeBranch: thread.associatedWorktreeBranch ?? null,
                  associatedWorktreeRef: thread.associatedWorktreeRef ?? null,
                  preferredLocalBranch: input.preferredLocalReference,
                  preferredWorktreeBaseBranch: input.preferredWorkspaceBaseReference,
                  preferredNewWorktreeName: input.preferredNewWorkspaceName,
                });
                const toProjectWorkspacePath = (workspacePath: string | null) =>
                  workspacePath === null
                    ? null
                    : workspaceProjectPath(workspacePath, target.binding);
                return {
                  ...gitResult,
                  backend: "git",
                  epoch: target.epoch,
                  worktreePath: toProjectWorkspacePath(gitResult.worktreePath),
                  associatedWorktreePath: toProjectWorkspacePath(
                    gitResult.associatedWorktreePath,
                  ),
                } satisfies VcsHandoffThreadResult;
              }

              if (input.targetMode === "worktree") {
                if (thread.envMode === "worktree" && thread.worktreePath) {
                  const status = yield* dependencies.jj.status(thread.worktreePath);
                  return {
                    backend: "jj",
                    epoch: target.epoch,
                    targetMode: "worktree",
                    branch: status.currentBookmark,
                    worktreePath: thread.worktreePath,
                    associatedWorktreePath:
                      thread.associatedWorktreePath ?? thread.worktreePath,
                    associatedWorktreeBranch:
                      thread.associatedWorktreeBranch ?? status.currentBookmark,
                    associatedWorktreeRef:
                      thread.associatedWorktreeRef ?? status.revision.commitId,
                    changesTransferred: false,
                    conflictsDetected: status.hasConflicts,
                    message: "The thread is already using its JJ workspace.",
                  } satisfies VcsHandoffThreadResult;
                }

                const sourceStatus = yield* dependencies.jj.status(primaryProjectCwd);
                const sourceRevision = sourceStatus.revision;
                const associatedPath = thread.associatedWorktreePath ?? null;
                const reusableAssociatedPath =
                  associatedPath !== null &&
                  !(yield* Effect.promise(() => dependencies.pathExists(associatedPath)))
                    ? associatedPath
                    : null;
                const created = yield* createWorkspace({
                  projectId: input.projectId,
                  expectedEpoch: input.expectedEpoch,
                  sourceRef: sourceRevision.commitId,
                  path: reusableAssociatedPath,
                  copyChangesFromCurrent: true,
                });
                const continueLocal = dependencies.jj.startNewChange(
                  primaryProjectCwd,
                  sourceRevision.commitId,
                  "wip: Synara local workspace continuation",
                );
                yield* continueLocal.pipe(
                  Effect.onError(() =>
                    removeWorkspace({
                      projectId: input.projectId,
                      expectedEpoch: input.expectedEpoch,
                      path: created.workspace.path,
                      force: true,
                    }).pipe(Effect.ignore),
                  ),
                );
                const [workspaceStatus, workspaceRef] = yield* Effect.all(
                  [
                    dependencies.jj.status(created.workspace.path),
                    dependencies.jj.resolveNearestBookmark(created.workspace.path),
                  ],
                  { concurrency: 2 },
                );
                return {
                  backend: "jj",
                  epoch: target.epoch,
                  targetMode: "worktree",
                  branch: workspaceRef,
                  worktreePath: created.workspace.path,
                  associatedWorktreePath: created.workspace.path,
                  associatedWorktreeBranch: workspaceRef,
                  associatedWorktreeRef: workspaceStatus.revision.commitId,
                  changesTransferred:
                    sourceStatus.hasChanges || sourceStatus.hasConflicts,
                  conflictsDetected: workspaceStatus.hasConflicts,
                  message:
                    "The thread moved into a JJ workspace; its current change is preserved as shared revision history.",
                } satisfies VcsHandoffThreadResult;
              }

              if (thread.envMode !== "worktree" || !thread.worktreePath) {
                const status = yield* dependencies.jj.status(primaryProjectCwd);
                return {
                  backend: "jj",
                  epoch: target.epoch,
                  targetMode: "local",
                  branch: status.currentBookmark,
                  worktreePath: null,
                  associatedWorktreePath: thread.associatedWorktreePath ?? null,
                  associatedWorktreeBranch:
                    thread.associatedWorktreeBranch ?? status.currentBookmark,
                  associatedWorktreeRef:
                    thread.associatedWorktreeRef ?? status.revision.commitId,
                  changesTransferred: false,
                  conflictsDetected: status.hasConflicts,
                  message: "The thread is already using the local JJ workspace.",
                } satisfies VcsHandoffThreadResult;
              }

              const sourceStatus = yield* dependencies.jj.status(thread.worktreePath);
              const localRevision = yield* dependencies.jj.readRevisionIdentity(
                primaryProjectCwd,
              );
              yield* dependencies.jj.withMutation(
                target.binding.repoRoot,
                dependencies.jj
                  .execute({
                    operation: "ProjectVcs.handoffThread.mergeIntoLocal",
                    cwd: primaryProjectCwd,
                    args: [
                      "new",
                      "--message",
                      "wip: Synara JJ workspace handoff",
                      sourceStatus.revision.changeId,
                      localRevision.changeId,
                    ],
                  })
                  .pipe(Effect.asVoid),
              );
              const localStatus = yield* dependencies.jj.status(primaryProjectCwd);
              const localRef = yield* dependencies.jj.resolveNearestBookmark(
                primaryProjectCwd,
              );
              yield* removeWorkspace({
                projectId: input.projectId,
                expectedEpoch: input.expectedEpoch,
                path: thread.worktreePath,
                force: true,
              });
              return {
                backend: "jj",
                epoch: target.epoch,
                targetMode: "local",
                branch: localRef,
                worktreePath: null,
                associatedWorktreePath:
                  thread.associatedWorktreePath ?? thread.worktreePath,
                associatedWorktreeBranch:
                  thread.associatedWorktreeBranch ?? sourceStatus.currentBookmark,
                associatedWorktreeRef:
                  thread.associatedWorktreeRef ?? sourceStatus.revision.commitId,
                changesTransferred:
                  sourceStatus.hasChanges || sourceStatus.hasConflicts,
                conflictsDetected: localStatus.hasConflicts,
                message:
                  "The JJ workspace revision was merged into the local workspace and the isolated workspace was removed.",
              } satisfies VcsHandoffThreadResult;
            }),
          ),
        ),
      ),
    );

  const pull: ProjectVcsShape["pull"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        target.backend === "git"
          ? dependencies.git
              .withMutation(
                target.cwd,
                dependencies.git.pullCurrentBranch(target.cwd),
              )
              .pipe(
                Effect.map((result) => ({
                  backend: "git" as const,
                  epoch: target.epoch,
                  status: result.status,
                  ref: result.branch,
                  upstreamRef: result.upstreamBranch,
                })),
              )
          : jjActions.pull({ cwd: target.cwd, epoch: target.epoch }),
      ),
    );

  const runStackedAction: ProjectVcsShape["runStackedAction"] = (input, options) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "jj") {
          return jjActions.runStackedAction(
            { cwd: target.cwd, epoch: target.epoch },
            input,
            options,
          );
        }
        const {
          projectId: _projectId,
          threadId: _threadId,
          expectedEpoch: _expectedEpoch,
          ...actionInput
        } = input;
        return dependencies.gitManager.runStackedAction(
          { ...actionInput, cwd: target.cwd },
          options?.publishProgress
            ? {
                progressReporter: {
                  publish: options.publishProgress,
                },
                actionId: input.actionId,
              }
            : undefined,
        );
      }),
    );

  return {
    setBackend,
    resolveTarget,
    status,
    readDiff,
    listReferences,
    createReference,
    switchReference,
    listWorkspaces,
    createWorkspace,
    removeWorkspace,
    handoffThread,
    pull,
    runStackedAction,
  };
}

export const makeProjectVcs = Effect.gen(function* () {
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const gitHubCli = yield* GitHubCli;
  const textGeneration = yield* TextGeneration;
  const jj = yield* JjCore;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const config = yield* ServerConfig;
  return makeProjectVcsWith({
    git,
    gitManager,
    gitHubCli,
    textGeneration,
    jj,
    orchestrationEngine,
    projection,
    canonicalizePath: nodeFs.realpath,
    now: () => new Date().toISOString(),
    makeCommandId: () =>
      CommandId.makeUnsafe(`server:vcs-binding:${Crypto.randomUUID()}`),
    worktreesDir: config.worktreesDir,
    pathExists: (path) =>
      nodeFs
        .access(path)
        .then(() => true)
        .catch(() => false),
    makeDirectory: (path) => nodeFs.mkdir(path, { recursive: true }).then(() => undefined),
    removeDirectory: (path) =>
      nodeFs.rm(path, { recursive: true, force: true }).then(() => undefined),
    randomToken: () => Crypto.randomUUID().replaceAll("-", "").slice(0, 12),
  });
});

export const ProjectVcsLive = Layer.effect(ProjectVcs, makeProjectVcs);
