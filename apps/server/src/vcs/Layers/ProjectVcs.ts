import * as Crypto from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  CommandId,
  type OrchestrationThreadPullRequest,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  type ProjectVcsBinding,
  type ServerSettingsError,
  type VcsBackend,
  type VcsFileChange,
  type VcsHandoffThreadResult,
  type VcsListReferencesResult,
  type VcsListWorkspacesResult,
  type VcsPullRequestStatus,
  type VcsStatusResult,
} from "@synara/contracts";
import { Effect, Layer, Option, Semaphore } from "effect";

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
  threadHasCheckpointRevertInProgress,
  threadHasInFlightTurn,
} from "../../orchestration/commandInvariants.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveGitHubRepository } from "../../pullRequests/repositoryResolution.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectVcsError } from "../Errors.ts";
import { makeJjActions } from "../jjActions.ts";
import {
  resolveJjBookmarkRemote,
  resolveJjGitHubHeadContext,
} from "../jjRemote.ts";
import {
  JjCore,
  type JjCoreShape,
  type JjWorkingCopyStatus,
} from "../Services/JjCore.ts";
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
  readonly getVcsBackend: Effect.Effect<VcsBackend, ServerSettingsError>;
  readonly setVcsBackend: (
    backend: VcsBackend,
  ) => Effect.Effect<void, ServerSettingsError>;
  readonly canonicalizePath: (path: string) => Promise<string>;
  readonly now: () => string;
  readonly makeCommandId: () => CommandId;
  readonly workspacesDir: string;
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

function storedPullRequestStatus(
  pullRequest: OrchestrationThreadPullRequest,
): VcsPullRequestStatus {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseBranch: pullRequest.baseBranch,
    headBranch: pullRequest.headBranch,
    state: pullRequest.state,
    isDraft: pullRequest.isDraft ?? false,
    mergeability: pullRequest.mergeability ?? "unknown",
    additions: pullRequest.additions ?? null,
    deletions: pullRequest.deletions ?? null,
    changedFiles: pullRequest.changedFiles ?? null,
  };
}

function chooseDefaultReference(names: ReadonlyArray<string>): string | null {
  const nameSet = new Set(names);
  return DEFAULT_REFERENCE_NAMES.find((name) => nameSet.has(name)) ?? names[0] ?? null;
}

export function makeProjectVcsWith(dependencies: ProjectVcsDependencies): ProjectVcsShape {
  const globalBackendMutation = Semaphore.makeUnsafe(1);
  const mutationLocks = new Map<
    ProjectId,
    { readonly semaphore: Semaphore.Semaphore; users: number }
  >();
  const withProjectMutation = <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      let entry = mutationLocks.get(projectId);
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
        mutationLocks.set(projectId, entry);
      }
      entry.users += 1;
      return yield* entry.semaphore.withPermit(effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry!.users -= 1;
            if (entry!.users === 0 && mutationLocks.get(projectId) === entry) {
              mutationLocks.delete(projectId);
            }
          }),
        ),
      );
    });
  const withProjectMutations = <A, E, R>(
    projectIds: ReadonlyArray<ProjectId>,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => {
    let guarded = effect;
    const orderedProjectIds = [...new Set(projectIds)].sort((left, right) =>
      String(left).localeCompare(String(right)),
    );
    for (const projectId of orderedProjectIds.reverse()) {
      guarded = withProjectMutation(projectId, guarded);
    }
    return guarded;
  };
  const jjActions = makeJjActions({
    jj: dependencies.jj,
    git: dependencies.git,
    gitHubCli: dependencies.gitHubCli,
    textGeneration: dependencies.textGeneration,
  });
  const readProject = (operation: string, projectId: ProjectId) =>
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

  const selectedJjBookmark = (
    target: ResolvedProjectVcsTarget,
    status: JjWorkingCopyStatus,
  ): string | null => {
    const preferred = target.preferredReference;
    return preferred &&
      status.bookmarks.some(
        (bookmark) => bookmark.name === preferred && bookmark.isLocal,
      )
      ? preferred
      : status.currentBookmark;
  };

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

  const hasAncestorEntry = (startPath: string, entryName: string) =>
    Effect.promise(async () => {
      let current = nodePath.resolve(startPath);
      while (true) {
        if (await dependencies.pathExists(nodePath.join(current, entryName))) {
          return true;
        }
        const parent = nodePath.dirname(current);
        if (parent === current) {
          return false;
        }
        current = parent;
      }
    });

  const readKnownThreadPullRequest = (
    target: ResolvedProjectVcsTarget,
    gitCwd: string,
    currentBookmark: string | null,
    remoteBookmark: string | null,
  ): Effect.Effect<
    VcsPullRequestStatus | null,
    import("../../persistence/Errors.ts").ProjectionRepositoryError
  > =>
    target.threadId
      ? dependencies.projection.getThreadShellById(target.threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(null),
              onSome: (thread) => {
                const stored = thread.lastKnownPr;
                if (!stored) {
                  return Effect.succeed(null);
                }
                const matchesCurrentBookmark =
                  currentBookmark !== null &&
                  (currentBookmark === stored.headBranch ||
                    remoteBookmark === stored.headBranch ||
                    currentBookmark.startsWith(
                      `synara/pr-${stored.number}/`,
                    ));
                if (!matchesCurrentBookmark) {
                  return Effect.succeed(null);
                }
                return dependencies.gitManager
                  .resolvePullRequest({
                    cwd: gitCwd,
                    reference: stored.url,
                  })
                  .pipe(
                    Effect.map((result) => result.pullRequest),
                    Effect.catch(() =>
                      Effect.succeed(storedPullRequestStatus(stored)),
                    ),
                  );
              },
            }),
          ),
        )
      : Effect.succeed(null);

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
    globalBackendMutation.withPermit(
      Effect.gen(function* () {
        const operation = "ProjectVcs.setBackend";
        const currentBackend = yield* dependencies.getVcsBackend;
        if (currentBackend === input.backend) {
          return { backend: currentBackend };
        }

        const snapshot = yield* dependencies.projection.getCommandReadModel();
        const projectIdsToLock = snapshot.projects
          .filter(
            (project) =>
              project.deletedAt === null &&
              (project.kind ?? "project") === "project" &&
              project.vcs.binding?.backend !== input.backend,
          )
          .map((project) => project.id);

        return yield* withProjectMutations(
          projectIdsToLock,
          Effect.gen(function* () {
            const currentSnapshot =
              yield* dependencies.projection.getCommandReadModel();
            const affectedProjectIds = new Set(
              currentSnapshot.projects
                .filter(
                  (project) =>
                    project.deletedAt === null &&
                    (project.kind ?? "project") === "project" &&
                    project.vcs.binding?.backend !== input.backend,
                )
                .map((project) => project.id),
            );
            const affectedThreads = currentSnapshot.threads.filter(
              (thread) =>
                thread.deletedAt === null &&
                affectedProjectIds.has(thread.projectId),
            );
            const activeThread =
              affectedThreads.find(threadHasInFlightTurn);
            if (activeThread) {
              return yield* projectError(
                operation,
                "backend-switch-blocked",
                `Thread '${activeThread.id}' has an active turn. Stop it before changing the global VCS backend.`,
              );
            }
            const revertingThread = affectedThreads.find(
              threadHasCheckpointRevertInProgress,
            );
            if (revertingThread) {
              return yield* projectError(
                operation,
                "backend-switch-blocked",
                `Thread '${revertingThread.id}' has a checkpoint revert in progress. Wait for it before changing the global VCS backend.`,
              );
            }
            const worktreeThreadCount = affectedThreads.filter(
              (thread) => thread.worktreePath !== null,
            ).length;
            if (worktreeThreadCount > 0) {
              return yield* projectError(
                operation,
                "backend-switch-blocked",
                `Move or remove ${worktreeThreadCount} existing workspace thread(s) before changing the global VCS backend.`,
              );
            }

            yield* dependencies.setVcsBackend(input.backend);
            return { backend: input.backend };
          }),
        );
      }),
    );

  const configureProject: ProjectVcsShape["configureProject"] = (input) =>
    Effect.gen(function* () {
      const operation = "ProjectVcs.configureProject";
      const backend = yield* dependencies.getVcsBackend;
      const project = yield* readProject(operation, input.projectId);
      const update = Effect.gen(function* () {
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

        const changesBackend =
          project.vcs.binding !== null &&
          project.vcs.binding.backend !== backend;
        const initializesJj =
          project.vcs.binding === null && backend === "jj";
        const assertNoWorktreeThreads = Effect.gen(function* () {
          const snapshot = yield* dependencies.projection.getShellSnapshot();
          const blockingThreadIds = snapshot.threads
            .filter(
              (thread) =>
                thread.projectId === input.projectId &&
                thread.worktreePath !== null,
            )
            .map((thread) => thread.id);
          if (blockingThreadIds.length > 0) {
            return yield* projectError(
              operation,
              "backend-switch-blocked",
              `Move or remove ${blockingThreadIds.length} existing worktree thread(s) before changing this project's VCS binding.`,
            );
          }
        });
        if (changesBackend || initializesJj) {
          yield* assertNoWorktreeThreads;
        }

        const binding = yield* detectBinding(
          operation,
          backend,
          project.workspaceRoot,
        ).pipe(
          Effect.catchTag("ProjectVcsError", (error) => {
            if (
              error.reason !== "repository-not-found" ||
              (project.vcs.binding !== null && backend !== "jj")
            ) {
              return Effect.fail(error);
            }
            const initialize =
              backend === "jj"
                ? Effect.gen(function* () {
                    const existingGit = yield* dependencies.git.execute({
                      operation: "ProjectVcs.findGitRepositoryForJjInit",
                      cwd: project.workspaceRoot,
                      args: ["rev-parse", "--show-toplevel"],
                      allowNonZeroExit: true,
                    });
                    const initRoot =
                      existingGit.code === 0 &&
                      existingGit.stdout.trim().length > 0
                        ? yield* canonicalize(
                            operation,
                            existingGit.stdout.trim(),
                          )
                        : project.workspaceRoot;
                    yield* dependencies.jj.initRepository(initRoot);
                  })
                : Effect.gen(function* () {
                    const canonicalProjectRoot = yield* canonicalize(
                      operation,
                      project.workspaceRoot,
                    );
                    if (
                      yield* hasAncestorEntry(canonicalProjectRoot, ".jj")
                    ) {
                      return yield* projectError(
                        operation,
                        "operation-unsupported",
                        "This project is already inside a JJ workspace without a Git working tree. Choose JJ instead of initializing a second repository.",
                      );
                    }
                    yield* dependencies.git.withMutation(
                      project.workspaceRoot,
                      dependencies.git.initRepo({
                        cwd: project.workspaceRoot,
                      }),
                    );
                  });
            return initialize.pipe(
              Effect.flatMap(() =>
                detectBinding(
                  operation,
                  backend,
                  project.workspaceRoot,
                ),
              ),
            );
          }),
        );
        if (
          project.vcs.binding &&
          bindingEquals(project.vcs.binding, binding)
        ) {
          return { vcs: project.vcs };
        }
        if (
          project.vcs.binding !== null &&
          !changesBackend &&
          !bindingEquals(project.vcs.binding, binding)
        ) {
          yield* assertNoWorktreeThreads;
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

      return yield* (
        project.vcs.binding?.backend === "git"
          ? dependencies.git.withMutation(project.workspaceRoot, update)
          : project.vcs.binding?.backend === "jj"
            ? dependencies.jj.withMutation(project.workspaceRoot, update)
            : update
      );
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
      const selectedBackend = yield* dependencies.getVcsBackend;
      const binding = project.vcs.binding;
      if (!binding || binding.backend !== selectedBackend) {
        return yield* projectError(
          operation,
          "backend-unconfigured",
          `This project is not configured for the global ${selectedBackend === "jj" ? "JJ" : "Git"} backend yet.`,
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
          preferredReference: null,
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
        preferredReference: thread.branch,
        cwd:
          thread.envMode === "worktree" && thread.worktreePath
            ? thread.worktreePath
            : (thread.workingDirectory ?? projectCwd),
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
              const currentBookmark = selectedJjBookmark(target, result);
              const bookmarkRemote = currentBookmark
                ? yield* resolveJjBookmarkRemote({
                    git: dependencies.git,
                    status: result,
                    bookmark: currentBookmark,
                  })
                : null;
              const remoteComparison = bookmarkRemote
                ? currentBookmark === result.currentBookmark &&
                  bookmarkRemote.remoteRevision === result.upstreamBookmark
                  ? {
                      aheadCount: result.aheadCount,
                      behindCount: result.behindCount,
                    }
                  : yield* dependencies.jj.compareBookmarkToRemote(
                      target.cwd,
                      bookmarkRemote.localBookmark,
                      bookmarkRemote.remoteName,
                      bookmarkRemote.remoteBookmark,
                    )
                : null;
              const bookmarkPullRequest =
                currentBookmark && result.repository.gitStorePath
                  ? yield* Effect.gen(function* () {
                      const head = yield* resolveJjGitHubHeadContext({
                        git: dependencies.git,
                        gitCwd: result.repository.gitStorePath!,
                        bookmark: currentBookmark!,
                        remote: bookmarkRemote,
                      });
                      for (const headSelector of head.selectors) {
                        const matches =
                          yield* dependencies.gitHubCli.listOpenPullRequests({
                            cwd: result.repository.gitStorePath!,
                            headSelector,
                            limit: 10,
                          });
                        const match = matches[0];
                        if (match) {
                          return {
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
                          };
                        }
                      }
                      return null;
                    }).pipe(Effect.catch(() => Effect.succeed(null)))
                  : null;
              const pullRequest =
                bookmarkPullRequest ??
                (result.repository.gitStorePath
                  ? yield* readKnownThreadPullRequest(
                      target,
                      result.repository.gitStorePath,
                      currentBookmark,
                      bookmarkRemote?.remoteBookmark ?? null,
                    )
                  : null);
              return {
                  backend: "jj",
                  epoch: target.epoch,
                  ref: currentBookmark,
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
                  remote: bookmarkRemote && remoteComparison
                    ? {
                        ref: bookmarkRemote.remoteRevision,
                        aheadCount: remoteComparison.aheadCount,
                        behindCount: remoteComparison.behindCount,
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
          return Effect.gen(function* () {
            const jjStatus = yield* dependencies.jj.status(target.cwd);
            const currentBookmark = selectedJjBookmark(target, jjStatus);
            const upstream = currentBookmark
              ? yield* resolveJjBookmarkRemote({
                  git: dependencies.git,
                  status: jjStatus,
                  bookmark: currentBookmark,
                })
              : null;
            const defaultBase = DEFAULT_REFERENCE_NAMES.flatMap((name) => {
              const bookmark = jjStatus.bookmarks.find(
                (candidate) => candidate.name === name,
              );
              if (!bookmark) return [];
              const remote = bookmark.remotes
                .filter((candidate) => candidate.targetChangeId !== null)
                .toSorted(
                  (left, right) =>
                    Number(right.name === "origin") -
                      Number(left.name === "origin") ||
                    Number(right.tracked) - Number(left.tracked) ||
                    left.name.localeCompare(right.name),
                )[0];
              if (remote) return [`${name}@${remote.name}`];
              return bookmark.isLocal && name !== currentBookmark
                ? [name]
                : [];
            })[0];
            return yield* dependencies.jj.readRangeDiff(
              target.cwd,
              upstream?.remoteRevision ?? defaultBase ?? "@-",
              "@",
            );
          }).pipe(
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

  type JjWorkspaceProjection = {
    readonly name: string;
    readonly path: string | null;
    readonly stale: boolean;
    readonly current: boolean;
    readonly ref: string | null;
  };

  const threadWorkspaceMappings = (
    workspaces: ReadonlyArray<JjWorkspaceProjection>,
    target: ResolvedProjectVcsTarget,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) => {
    const registeredPaths = new Set(
      workspaces.flatMap((workspace) =>
        workspace.path ? [nodePath.resolve(workspace.path)] : [],
      ),
    );
    const mappingsByPath = new Map<
      string,
      { readonly ref: string; readonly path: string; readonly priority: number }
    >();
    const mappings = threads
      .flatMap((thread) => {
        if (
          thread.projectId !== target.projectId ||
          !thread.branch ||
          !thread.worktreePath
        ) {
          return [];
        }
        const resolvedPath = nodePath.resolve(thread.worktreePath);
        if (!registeredPaths.has(resolvedPath)) return [];
        return [
          {
            ref: thread.branch,
            path: thread.worktreePath,
            resolvedPath,
            priority:
              thread.id === target.threadId
                ? 2
                : resolvedPath === nodePath.resolve(target.cwd)
                  ? 1
                  : 0,
          },
        ];
      })
      .toSorted((left, right) => left.priority - right.priority);
    for (const mapping of mappings) {
      mappingsByPath.set(mapping.resolvedPath, mapping);
    }
    return mappingsByPath;
  };

  const listJjWorkspaceProjections = (
    target: ResolvedProjectVcsTarget,
  ): Effect.Effect<
    ReadonlyArray<JjWorkspaceProjection>,
    import("../Errors.ts").JjCommandError
  > =>
    dependencies.jj.listWorkspaces(target.binding.repoRoot).pipe(
      Effect.flatMap((workspaces) =>
        Effect.forEach(
          workspaces,
          (workspace) => {
            if (workspace.registration.kind === "stale") {
              return Effect.succeed({
                name: workspace.name,
                path: null,
                stale: true,
                current: false,
                ref: null,
              });
            }
            const path = workspaceProjectPath(
              workspace.registration.root,
              target.binding,
            );
            return dependencies.jj.resolveNearestBookmark(path).pipe(
              Effect.map((ref) => ({
                name: workspace.name,
                path,
                stale: false,
                current:
                  nodePath.resolve(path) === nodePath.resolve(target.cwd),
                ref,
              })),
              Effect.catch(() =>
                Effect.succeed({
                  name: workspace.name,
                  path,
                  stale: false,
                  current:
                    nodePath.resolve(path) === nodePath.resolve(target.cwd),
                  ref: null,
                }),
              ),
            );
          },
          { concurrency: 4 },
        ),
      ),
    );

  const workspacePathByReference = (
    workspaces: ReadonlyArray<JjWorkspaceProjection>,
    target: ResolvedProjectVcsTarget,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) => {
    const paths = new Map<string, string>();
    for (const workspace of workspaces) {
      if (!workspace.ref || !workspace.path) continue;
      if (!paths.has(workspace.ref) || workspace.current) {
        paths.set(workspace.ref, workspace.path);
      }
    }
    for (const [resolvedPath, mapping] of threadWorkspaceMappings(
      workspaces,
      target,
      threads,
    )) {
      for (const [ref, path] of paths) {
        if (
          ref !== mapping.ref &&
          nodePath.resolve(path) === resolvedPath
        ) {
          paths.delete(ref);
        }
      }
      paths.set(mapping.ref, mapping.path);
    }
    return paths;
  };

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
          [
            dependencies.jj.status(target.cwd),
            listJjWorkspaceProjections(target),
            dependencies.jj.listGitRemotes(target.cwd),
            dependencies.projection.getShellSnapshot(),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.map(([jjStatus, workspaces, remotes, snapshot]): VcsListReferencesResult => {
            const workspacePaths = workspacePathByReference(
              workspaces,
              target,
              snapshot.threads,
            );
            const currentBookmark = selectedJjBookmark(target, jjStatus);
            const localNames = jjStatus.bookmarks
              .filter((bookmark) => bookmark.isLocal)
              .map((bookmark) => bookmark.name)
              .toSorted((left, right) => left.localeCompare(right));
            const defaultName = chooseDefaultReference(localNames);
            const references = jjStatus.bookmarks.flatMap((bookmark) => {
              const trackedRemotes = bookmark.remotes.filter(
                (remote) => remote.tracked,
              );
              const localReference = bookmark.isLocal
                ? [
                    {
                      name: bookmark.name,
                      kind: "bookmark" as const,
                      isRemote: false,
                      remoteName: null,
                      current: bookmark.name === currentBookmark,
                      isDefault: bookmark.name === defaultName,
                      workspacePath: workspacePaths.get(bookmark.name) ?? null,
                      conflicted: bookmark.conflicted,
                      tracked: trackedRemotes.length > 0,
                      synced:
                        trackedRemotes.length > 0 &&
                        trackedRemotes.every((remote) => remote.synced),
                    },
                  ]
                : [];
              const remoteReferences = bookmark.remotes
                .filter((remote) => remote.targetChangeId !== null)
                .map((remote) => ({
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
              hasOriginRemote: remotes.some((remote) => remote.name === "origin"),
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
        return listJjWorkspaceProjections(target).pipe(
          Effect.map(
            (workspaces): VcsListWorkspacesResult => ({
              backend: "jj",
              epoch: target.epoch,
              workspaces,
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
        return Effect.gen(function* () {
          const status = yield* dependencies.jj.status(target.cwd);
          const hasWorkingCopyState =
            status.hasChanges || status.hasConflicts;
          // A Git branch starts at HEAD, not at uncommitted working-tree
          // contents. Anchor a published JJ bookmark at @- first, then move
          // only the local bookmark to the mutable working-copy change.
          const initialRevision =
            input.publish === true || !hasWorkingCopyState ? "@-" : "@";
          yield* dependencies.jj.createBookmark(
            target.cwd,
            input.name,
            initialRevision,
          );
          if (input.publish === true) {
            yield* dependencies.jj.pushBookmark(
              target.cwd,
              input.name,
              "origin",
            );
            if (hasWorkingCopyState) {
              yield* dependencies.jj.setBookmark(
                target.cwd,
                input.name,
                "@",
              );
            }
          }
          return {
            backend: "jj" as const,
            epoch: target.epoch,
            ref: input.name,
          };
        });
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
        return Effect.gen(function* () {
          const status = yield* dependencies.jj.status(target.cwd);
          const remote = status.bookmarks
            .flatMap((bookmark) =>
              bookmark.remotes.map((candidate) => ({
                bookmark,
                remote: candidate,
                reference: `${bookmark.name}@${candidate.name}`,
              })),
            )
            .find(
              (candidate) =>
                candidate.reference === input.ref &&
                candidate.remote.targetChangeId !== null,
            );
          let revisionRef = input.ref;
          let selectedRef = input.ref;
          let selectedTargetChangeId = status.bookmarks.find(
            (bookmark) => bookmark.name === input.ref,
          )?.targetChangeId ?? null;
          if (remote && !remote.bookmark.isLocal) {
            yield* dependencies.jj.trackBookmark(target.cwd, input.ref);
            revisionRef = remote.bookmark.name;
            selectedRef = remote.bookmark.name;
            selectedTargetChangeId = remote.remote.targetChangeId;
          }
          const currentTargetChangeId = status.currentBookmark
            ? status.bookmarks.find(
                (bookmark) => bookmark.name === status.currentBookmark,
              )?.targetChangeId ?? null
            : null;
          if (
            selectedTargetChangeId !== null &&
            (selectedTargetChangeId === status.revision.changeId ||
              selectedTargetChangeId === currentTargetChangeId)
          ) {
            return {
              backend: "jj" as const,
              epoch: target.epoch,
              ref: selectedRef,
              revision: status.revision,
            };
          }
          if (status.hasChanges || status.hasConflicts) {
            return yield* projectError(
              "ProjectVcs.switchReference",
              "operation-unsupported",
              "Commit or resolve the current JJ working-copy changes before switching bookmarks.",
            );
          }
          const revision = yield* dependencies.jj.startNewChange(
            target.cwd,
            revisionRef,
            `wip: Synara on ${selectedRef}`,
          );
          return {
            backend: "jj" as const,
            epoch: target.epoch,
            ref: selectedRef,
            revision,
          };
        });
      }),
    );

  const prepareGeneratedWorkspace = (operation: string) =>
    Effect.tryPromise({
      try: async () => {
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const token = dependencies.randomToken();
          const parent = nodePath.join(dependencies.workspacesDir, token);
          const root = nodePath.join(parent, "synara");
          if (await dependencies.pathExists(root)) {
            continue;
          }
          await dependencies.makeDirectory(parent);
          return { root, name: `synara-${token}` };
        }
        const token = dependencies.randomToken();
        const parent = nodePath.join(dependencies.workspacesDir, token);
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
          const cleanupWorkspacePath =
            generated === null
              ? requestedWorkspaceRoot
              : nodePath.dirname(requestedWorkspaceRoot);
          const cleanupPreparedWorkspace = Effect.promise(() =>
            dependencies.removeDirectory(cleanupWorkspacePath),
          ).pipe(Effect.ignore);

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

          // `@` and relative revsets are workspace-local. Resolve them from
          // the caller's actual workspace after one filesystem snapshot, then
          // pass an immutable commit id to `jj workspace add` at the repo root.
          const sourceStatus = yield* dependencies.jj
            .status(target.cwd)
            .pipe(Effect.onError(() => cleanupPreparedWorkspace));
          const sourceRevision =
            input.sourceRef === "@" ||
            input.sourceRef === sourceStatus.revision.commitId
              ? sourceStatus.revision
              : yield* dependencies.jj.readRevisionIdentity(
                  target.cwd,
                  input.sourceRef,
                ).pipe(Effect.onError(() => cleanupPreparedWorkspace));
          if (
            input.copyChangesFromCurrent &&
            sourceRevision.commitId !== sourceStatus.revision.commitId
          ) {
            yield* cleanupPreparedWorkspace;
            return yield* projectError(
              operation,
              "operation-unsupported",
              "JJ can copy current workspace changes only when the source revision resolves to the current change.",
            );
          }

          const workspaceName = generated?.name ?? `synara-${dependencies.randomToken()}`;
          const create = dependencies.jj
            .createWorkspace({
              repositoryPath: target.binding.repoRoot,
              workspacePath: requestedWorkspaceRoot,
              workspaceName,
              revision: sourceRevision.commitId,
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
                        dependencies.removeDirectory(cleanupWorkspacePath),
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
          // Always snapshot the JJ working copy before forgetting it. Forced
          // retention cleanup may remove a dirty workspace, but its revision
          // must remain recoverable from the shared JJ repository.
          const workspaceStatus = yield* dependencies.jj.status(requestedProjectPath);
          if (
            input.force !== true &&
            (workspaceStatus.hasChanges || workspaceStatus.hasConflicts)
          ) {
            return yield* projectError(
              operation,
              "workspace-dirty",
              "The JJ workspace has changes or conflicts; resolve them or request a forced removal.",
            );
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
                  targetMode:
                    input.targetMode === "workspace" ? "worktree" : "local",
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
                  backend: "git",
                  epoch: target.epoch,
                  targetMode: input.targetMode,
                  branch: gitResult.branch,
                  workspacePath: toProjectWorkspacePath(gitResult.worktreePath),
                  associatedWorkspacePath: toProjectWorkspacePath(
                    gitResult.associatedWorktreePath,
                  ),
                  associatedWorkspaceBranch: gitResult.associatedWorktreeBranch,
                  associatedWorkspaceRef: gitResult.associatedWorktreeRef,
                  changesTransferred: gitResult.changesTransferred,
                  conflictsDetected: gitResult.conflictsDetected,
                  message: gitResult.message,
                } satisfies VcsHandoffThreadResult;
              }

              if (input.targetMode === "workspace") {
                if (thread.envMode === "worktree" && thread.worktreePath) {
                  const status = yield* dependencies.jj.status(thread.worktreePath);
                  return {
                    backend: "jj",
                    epoch: target.epoch,
                    targetMode: "workspace",
                    branch: status.currentBookmark,
                    workspacePath: thread.worktreePath,
                    associatedWorkspacePath:
                      thread.associatedWorktreePath ?? thread.worktreePath,
                    associatedWorkspaceBranch:
                      thread.associatedWorktreeBranch ?? status.currentBookmark,
                    associatedWorkspaceRef:
                      thread.associatedWorktreeRef ?? status.revision.commitId,
                    changesTransferred: false,
                    conflictsDetected: status.hasConflicts,
                    message: "The thread is already using its JJ workspace.",
                  } satisfies VcsHandoffThreadResult;
                }

                const sourceStatus = yield* dependencies.jj.status(primaryProjectCwd);
                const sourceRevision = sourceStatus.revision;
                const sourceBookmark = selectedJjBookmark(target, sourceStatus);
                const requestedBookmark =
                  input.preferredNewWorkspaceName?.trim() || null;
                const createdBookmark =
                  requestedBookmark && requestedBookmark !== sourceBookmark
                    ? yield* dependencies.jj
                        .createBookmark(
                          primaryProjectCwd,
                          requestedBookmark,
                          sourceRevision.commitId,
                        )
                        .pipe(Effect.as(requestedBookmark))
                    : null;
                const workspaceBookmark =
                  createdBookmark ?? requestedBookmark ?? sourceBookmark;
                const cleanupCreatedBookmark =
                  createdBookmark === null
                    ? Effect.void
                    : dependencies.jj
                        .deleteBookmark(primaryProjectCwd, createdBookmark)
                        .pipe(Effect.ignore);
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
                }).pipe(
                  Effect.onError(() => cleanupCreatedBookmark),
                );
                const continueLocal = dependencies.jj.startNewChange(
                  primaryProjectCwd,
                  sourceRevision.commitId,
                  "wip: Synara local workspace continuation",
                );
                yield* continueLocal.pipe(
                  Effect.onError(() =>
                    Effect.all(
                      [
                        removeWorkspace({
                          projectId: input.projectId,
                          expectedEpoch: input.expectedEpoch,
                          path: created.workspace.path,
                          force: true,
                        }).pipe(Effect.ignore),
                        cleanupCreatedBookmark,
                      ],
                      { discard: true },
                    ),
                  ),
                );
                const workspaceStatus = yield* dependencies.jj.status(
                  created.workspace.path,
                );
                const workspaceRef =
                  workspaceBookmark ??
                  (yield* dependencies.jj.resolveNearestBookmark(
                    created.workspace.path,
                  ));
                return {
                  backend: "jj",
                  epoch: target.epoch,
                  targetMode: "workspace",
                  branch: workspaceRef,
                  workspacePath: created.workspace.path,
                  associatedWorkspacePath: created.workspace.path,
                  associatedWorkspaceBranch: workspaceRef,
                  associatedWorkspaceRef: workspaceStatus.revision.commitId,
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
                  workspacePath: null,
                  associatedWorkspacePath: thread.associatedWorktreePath ?? null,
                  associatedWorkspaceBranch:
                    thread.associatedWorktreeBranch ?? status.currentBookmark,
                  associatedWorkspaceRef:
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
                workspacePath: null,
                associatedWorkspacePath:
                  thread.associatedWorktreePath ?? thread.worktreePath,
                associatedWorkspaceBranch:
                  thread.associatedWorktreeBranch ?? sourceStatus.currentBookmark,
                associatedWorkspaceRef:
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
          : jjActions.pull({
              cwd: target.cwd,
              epoch: target.epoch,
              preferredBookmark: target.preferredReference,
            }),
      ),
    );

  const remoteGitCwdFor = (
    operation: string,
    target: ResolvedProjectVcsTarget,
  ) =>
    target.backend === "git"
      ? Effect.succeed(target.cwd)
      : dependencies.jj.detectRepository(target.cwd).pipe(
          Effect.flatMap((repository) =>
            repository?.gitStorePath
              ? Effect.succeed(repository.gitStorePath)
              : Effect.fail(
                  projectError(
                    operation,
                    "operation-unsupported",
                    "This JJ repository has no Git backing store for GitHub operations.",
                  ),
                ),
          ),
        );

  const remoteGitCwd: ProjectVcsShape["remoteGitCwd"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        remoteGitCwdFor("ProjectVcs.remoteGitCwd", target),
      ),
    );

  const materializePullRequestHeadForTarget = (
    operation: string,
    target: ResolvedProjectVcsTarget,
    reference: string,
  ) =>
    Effect.gen(function* () {
      const gitCwd = yield* remoteGitCwdFor(operation, target);
      const materialized =
        yield* dependencies.gitManager.materializePullRequestHead({
          cwd: gitCwd,
          reference,
        });
      if (target.backend === "git") {
        const revision = yield* dependencies.git.execute({
          operation,
          cwd: target.cwd,
          args: [
            "rev-parse",
            "--verify",
            "--end-of-options",
            `${materialized.branch}^{commit}`,
          ],
        });
        return {
          ...materialized,
          revision: revision.stdout.trim(),
        };
      }

      yield* dependencies.jj.importGit(target.cwd);
      const importedBookmarks = yield* dependencies.jj.listBookmarks(target.cwd);
      const importedBookmark = importedBookmarks.find(
        (bookmark) =>
          bookmark.isLocal && bookmark.name === materialized.branch,
      );
      if (!importedBookmark) {
        return yield* projectError(
          operation,
          "operation-unsupported",
          `JJ did not import the pull request head bookmark '${materialized.branch}'.`,
        );
      }
      const revision = yield* dependencies.jj.readRevisionIdentity(
        target.cwd,
        materialized.branch,
      );
      let branch = materialized.branch;
      if (materialized.branch !== materialized.pullRequest.headBranch) {
        const configuredRemoteName =
          yield* dependencies.git
            .readConfigValue(
              gitCwd,
              `branch.${materialized.branch}.remote`,
            )
            .pipe(Effect.catch(() => Effect.succeed(null)));
        const headBookmark = importedBookmarks.find(
          (bookmark) =>
            bookmark.name === materialized.pullRequest.headBranch,
        );
        const matchingRemote =
          headBookmark?.remotes.find(
            (remote) =>
              remote.name === configuredRemoteName &&
              remote.targetChangeId === revision.changeId,
          ) ??
          headBookmark?.remotes.find(
            (remote) =>
              remote.targetChangeId === revision.changeId,
          );
        const localHeadIsAvailable =
          !headBookmark?.isLocal ||
          headBookmark.targetChangeId === revision.changeId;
        if (matchingRemote && localHeadIsAvailable) {
          if (!headBookmark?.isLocal) {
            yield* dependencies.jj.createBookmark(
              target.cwd,
              materialized.pullRequest.headBranch,
              materialized.branch,
            );
          }
          if (!matchingRemote.tracked) {
            yield* dependencies.jj.trackBookmark(
              target.cwd,
              `${materialized.pullRequest.headBranch}@${matchingRemote.name}`,
            );
          }
          yield* dependencies.jj.deleteBookmark(
            target.cwd,
            materialized.branch,
          );
          branch = materialized.pullRequest.headBranch;
        }
      }
      return {
        ...materialized,
        branch,
        revision: revision.commitId,
      };
    });

  const materializePullRequestHead: ProjectVcsShape["materializePullRequestHead"] = (
    input,
  ) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        materializePullRequestHeadForTarget(
          "ProjectVcs.materializePullRequestHead",
          target,
          input.reference,
        ),
      ),
    );

  const resolvePullRequest: ProjectVcsShape["resolvePullRequest"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        remoteGitCwdFor("ProjectVcs.resolvePullRequest", target).pipe(
          Effect.flatMap((cwd) =>
            dependencies.gitManager.resolvePullRequest({
              cwd,
              reference: input.reference,
            }),
          ),
          Effect.map((result) => ({
            backend: target.backend,
            epoch: target.epoch,
            pullRequest: result.pullRequest,
          })),
        ),
      ),
    );

  const githubRepository: ProjectVcsShape["githubRepository"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        remoteGitCwdFor("ProjectVcs.githubRepository", target).pipe(
          Effect.flatMap((cwd) => resolveGitHubRepository(dependencies.git, cwd)),
          Effect.map((result) => ({
            backend: target.backend,
            epoch: target.epoch,
            ...result,
          })),
        ),
      ),
    );

  const pullRequestSnapshot: ProjectVcsShape["pullRequestSnapshot"] = (input) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) =>
        remoteGitCwdFor("ProjectVcs.pullRequestSnapshot", target).pipe(
          Effect.flatMap((cwd) =>
            dependencies.gitManager.pullRequestSnapshot({
              cwd,
              reference: input.reference,
            }),
          ),
          Effect.map((result) => ({
            backend: target.backend,
            epoch: target.epoch,
            ...result,
          })),
        ),
      ),
    );

  const findReusableJjPullRequestWorkspace = (
    target: ResolvedProjectVcsTarget,
    bookmark: string,
  ) =>
    Effect.all(
      [
        listJjWorkspaceProjections(target),
        dependencies.projection.getShellSnapshot(),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.flatMap(([workspaces, snapshot]) => {
        const threadMappings = threadWorkspaceMappings(
          workspaces,
          target,
          snapshot.threads,
        );
        return Effect.forEach(
          workspaces,
          (workspace) => {
            if (!workspace.path || workspace.stale || workspace.current) {
              return Effect.succeed(null);
            }
            const projected = threadMappings.get(
              nodePath.resolve(workspace.path),
            );
            if ((projected?.ref ?? workspace.ref) !== bookmark) {
              return Effect.succeed(null);
            }
            return Effect.promise(() =>
              dependencies.pathExists(workspace.path!),
            ).pipe(
              Effect.map((exists) => (exists ? workspace.path : null)),
            );
          },
          { concurrency: 4 },
        );
      }),
      Effect.map((paths) => paths.find((path) => path !== null) ?? null),
    );

  const preparePullRequestThread: ProjectVcsShape["preparePullRequestThread"] = (
    input,
  ) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "git") {
          return dependencies.gitManager
            .preparePullRequestThread({
              cwd: target.cwd,
              reference: input.reference,
              mode: input.mode === "workspace" ? "worktree" : "local",
            })
            .pipe(
              Effect.map((result) => ({
                backend: "git" as const,
                epoch: target.epoch,
                pullRequest: result.pullRequest,
                branch: result.branch,
                workspacePath: result.worktreePath,
              })),
            );
        }

        return Effect.gen(function* () {
          const materialized = yield* materializePullRequestHeadForTarget(
            "ProjectVcs.preparePullRequestThread",
            target,
            input.reference,
          );

          if (input.mode === "local") {
            yield* dependencies.jj.startNewChange(
              target.cwd,
              materialized.branch,
              `wip: Synara pull request #${materialized.pullRequest.number}`,
            );
            return {
              backend: "jj",
              epoch: target.epoch,
              pullRequest: materialized.pullRequest,
              branch: materialized.branch,
              workspacePath: null,
            } as const;
          }

          const reusablePath = yield* findReusableJjPullRequestWorkspace(
            target,
            materialized.branch,
          );
          if (reusablePath) {
            return {
              backend: "jj",
              epoch: target.epoch,
              pullRequest: materialized.pullRequest,
              branch: materialized.branch,
              workspacePath: reusablePath,
            } as const;
          }

          const created = yield* createWorkspace({
            projectId: input.projectId,
            expectedEpoch: input.expectedEpoch,
            sourceRef: materialized.branch,
            path: null,
            copyChangesFromCurrent: false,
          });
          return {
            backend: "jj",
            epoch: target.epoch,
            pullRequest: materialized.pullRequest,
            branch: materialized.branch,
            workspacePath: created.workspace.path,
          } as const;
        });
      }),
    );

  const runStackedAction: ProjectVcsShape["runStackedAction"] = (input, options) =>
    resolveTarget(input).pipe(
      Effect.flatMap((target) => {
        if (target.backend === "jj") {
          return jjActions.runStackedAction(
            {
              cwd: target.cwd,
              epoch: target.epoch,
              preferredBookmark: target.preferredReference,
            },
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
    getBackend: dependencies.getVcsBackend,
    setBackend,
    configureProject: (input) =>
      withProjectMutation(input.projectId, configureProject(input)),
    resolveTarget,
    status,
    readDiff,
    listReferences,
    createReference: (input) =>
      withProjectMutation(input.projectId, createReference(input)),
    switchReference: (input) =>
      withProjectMutation(input.projectId, switchReference(input)),
    listWorkspaces,
    createWorkspace: (input) =>
      withProjectMutation(input.projectId, createWorkspace(input)),
    removeWorkspace: (input) =>
      withProjectMutation(input.projectId, removeWorkspace(input)),
    handoffThread: (input) =>
      withProjectMutation(input.projectId, handoffThread(input)),
    pull: (input) =>
      withProjectMutation(input.projectId, pull(input)),
    githubRepository,
    remoteGitCwd,
    resolvePullRequest,
    materializePullRequestHead: (input) =>
      withProjectMutation(
        input.projectId,
        materializePullRequestHead(input),
      ),
    pullRequestSnapshot,
    preparePullRequestThread: (input) =>
      withProjectMutation(
        input.projectId,
        preparePullRequestThread(input),
      ),
    runStackedAction: (input, options) =>
      withProjectMutation(
        input.projectId,
        runStackedAction(input, options),
      ),
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
  const serverSettings = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  return makeProjectVcsWith({
    git,
    gitManager,
    gitHubCli,
    textGeneration,
    jj,
    orchestrationEngine,
    projection,
    getVcsBackend: serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.vcsBackend),
    ),
    setVcsBackend: (backend) =>
      serverSettings.updateSettings({ vcsBackend: backend }).pipe(Effect.asVoid),
    canonicalizePath: nodeFs.realpath,
    now: () => new Date().toISOString(),
    makeCommandId: () =>
      CommandId.makeUnsafe(`server:vcs-binding:${Crypto.randomUUID()}`),
    workspacesDir: config.workspacesDir,
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
