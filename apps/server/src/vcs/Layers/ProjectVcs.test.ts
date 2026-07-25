import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type ProjectVcsBinding,
  type VcsBackend,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import type { GitManagerShape } from "../../git/Services/GitManager.ts";
import type { TextGenerationShape } from "../../git/Services/TextGeneration.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { JjCoreShape } from "../Services/JjCore.ts";
import {
  makeProjectVcsWith,
  type ProjectVcsDependencies,
} from "./ProjectVcs.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-vcs-service");
const THREAD_ID = ThreadId.makeUnsafe("thread-vcs-service");
const NOW = "2026-07-25T00:00:00.000Z";

function project(
  vcs: OrchestrationProjectShell["vcs"],
  workspaceRoot = "/repo/app",
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "project",
    title: "VCS project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    spaceId: null,
    vcs,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function dependencies(input: {
  project: OrchestrationProjectShell;
  vcsBackend?: VcsBackend;
  commandReadModel?: Record<string, unknown>;
  thread?: Record<string, unknown> | null;
  shellThreads?: ReadonlyArray<Record<string, unknown>>;
  git?: Partial<GitCoreShape>;
  gitManager?: Partial<GitManagerShape>;
  gitHubCli?: Partial<GitHubCliShape>;
  textGeneration?: Partial<TextGenerationShape>;
  jj?: Partial<JjCoreShape>;
  pathExists?: (path: string) => Promise<boolean>;
  removeDirectory?: (path: string) => Promise<void>;
}) {
  const dispatched: unknown[] = [];
  let vcsBackend =
    input.vcsBackend ?? input.project.vcs.binding?.backend ?? "git";
  const setVcsBackend = vi.fn((backend: VcsBackend) =>
    Effect.sync(() => {
      vcsBackend = backend;
    }),
  );
  const projection = {
    getProjectShellById: () => Effect.succeed(Option.some(input.project)),
    getThreadShellById: () =>
      Effect.succeed(input.thread === null ? Option.none() : Option.some(input.thread)),
    getShellSnapshot: () =>
      Effect.succeed({
        sequence: 1,
        spaces: [],
        projects: [input.project],
        threads: input.shellThreads ?? [],
      }),
    getCommandReadModel: () =>
      Effect.succeed(
        input.commandReadModel ?? {
          snapshotSequence: 1,
          spaces: [],
          projects: [{ ...input.project, deletedAt: null }],
          threads: [],
          updatedAt: NOW,
        },
      ),
  } as unknown as ProjectionSnapshotQueryShape;
  const orchestrationEngine = {
    dispatch: (command: unknown) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 2 };
      }),
  } as unknown as OrchestrationEngineShape;
  return {
    dispatched,
    setVcsBackend,
    value: {
      git: {
        execute: () =>
          Effect.succeed({ code: 1, stdout: "", stderr: "" }),
        readConfigValue: () => Effect.succeed(null),
        withMutation: (_cwd, effect) => effect,
        ...(input.git ?? {}),
      },
      gitManager: input.gitManager ?? {},
      gitHubCli: input.gitHubCli ?? {},
      textGeneration: input.textGeneration ?? {},
      jj: {
        listGitRemotes: () => Effect.succeed([]),
        resolveNearestBookmark: () => Effect.succeed(null),
        deleteBookmark: () => Effect.void,
        withMutation: (_cwd, effect) => effect,
        ...(input.jj ?? {}),
      },
      orchestrationEngine,
      projection,
      getVcsBackend: Effect.sync(() => vcsBackend),
      setVcsBackend,
      canonicalizePath: async (path: string) => path,
      now: () => NOW,
      makeCommandId: () => CommandId.makeUnsafe("cmd-project-vcs-service"),
      workspacesDir: "/managed",
      pathExists: input.pathExists ?? (async () => false),
      makeDirectory: async () => undefined,
      removeDirectory: input.removeDirectory ?? (async () => undefined),
      randomToken: () => "abc123",
    } as ProjectVcsDependencies,
  };
}

const jjBinding: ProjectVcsBinding = {
  backend: "jj",
  repoRoot: "/repo",
  projectRelativePath: "app",
};

const pullRequest = {
  number: 42,
  title: "Support JJ",
  url: "https://github.com/example/synara/pull/42",
  baseBranch: "main",
  headBranch: "feature/jj",
  state: "open" as const,
  isDraft: false,
  mergeability: "mergeable" as const,
  additions: 12,
  deletions: 3,
  changedFiles: 4,
};

describe("ProjectVcs", () => {
  it("changes the process-wide backend without mutating one project binding", async () => {
    const boundProject = project({
      epoch: 3,
      binding: { ...jjBinding, backend: "git" },
    });
    const deps = dependencies({
      project: boundProject,
      vcsBackend: "git",
      commandReadModel: {
        snapshotSequence: 1,
        spaces: [],
        projects: [{ ...boundProject, deletedAt: null }],
        threads: [],
        updatedAt: NOW,
      },
    });

    await expect(
      Effect.runPromise(makeProjectVcsWith(deps.value).setBackend({ backend: "jj" })),
    ).resolves.toEqual({ backend: "jj" });
    expect(deps.setVcsBackend).toHaveBeenCalledWith("jj");
    expect(deps.dispatched).toHaveLength(0);
  });

  it("blocks a global backend switch while an affected workspace thread exists", async () => {
    const boundProject = project({
      epoch: 3,
      binding: { ...jjBinding, backend: "git" },
    });
    const deps = dependencies({
      project: boundProject,
      vcsBackend: "git",
      commandReadModel: {
        snapshotSequence: 1,
        spaces: [],
        projects: [{ ...boundProject, deletedAt: null }],
        threads: [
          {
            id: THREAD_ID,
            projectId: PROJECT_ID,
            deletedAt: null,
            worktreePath: "/managed/existing",
            session: null,
            latestTurn: null,
            activities: [],
          },
        ],
        updatedAt: NOW,
      },
    });

    await expect(
      Effect.runPromise(makeProjectVcsWith(deps.value).setBackend({ backend: "jj" })),
    ).rejects.toThrow("Move or remove 1 existing workspace thread");
    expect(deps.setVcsBackend).not.toHaveBeenCalled();
  });

  it("treats an unbound project with an existing workspace as affected", async () => {
    const unboundProject = project({ epoch: 0, binding: null });
    const deps = dependencies({
      project: unboundProject,
      vcsBackend: "git",
      commandReadModel: {
        snapshotSequence: 1,
        spaces: [],
        projects: [{ ...unboundProject, deletedAt: null }],
        threads: [
          {
            id: THREAD_ID,
            projectId: PROJECT_ID,
            deletedAt: null,
            worktreePath: "/managed/legacy",
            session: null,
            latestTurn: null,
            activities: [],
          },
        ],
        updatedAt: NOW,
      },
    });

    await expect(
      Effect.runPromise(makeProjectVcsWith(deps.value).setBackend({ backend: "jj" })),
    ).rejects.toThrow("Move or remove 1 existing workspace thread");
    expect(deps.setVcsBackend).not.toHaveBeenCalled();
  });

  it("rejects project operations whose persisted binding differs from the global backend", async () => {
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      vcsBackend: "git",
    });

    await expect(
      Effect.runPromise(
        makeProjectVcsWith(deps.value).status({
          projectId: PROJECT_ID,
          expectedEpoch: 3,
        }),
      ),
    ).rejects.toThrow("not configured for the global Git backend");
  });

  it("detects and persists only the explicitly selected backend", async () => {
    const gitExecute = vi.fn(() =>
      Effect.succeed({ code: 0, stdout: "/repo\n", stderr: "" }),
    );
    const jjDetect = vi.fn(() =>
      Effect.succeed({
        workspaceRoot: "/repo",
        repositoryStorePath: "/store",
        gitStorePath: "/repo",
      }),
    );
    const deps = dependencies({
      project: project({ epoch: 0, binding: null }),
      vcsBackend: "jj",
      git: { execute: gitExecute },
      jj: { detectRepository: jjDetect },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.configureProject({
        projectId: PROJECT_ID,
        expectedEpoch: 0,
      }),
    );

    expect(result.vcs).toEqual({ epoch: 1, binding: jjBinding });
    expect(jjDetect).toHaveBeenCalledOnce();
    expect(gitExecute).not.toHaveBeenCalled();
    expect(deps.dispatched).toEqual([
      expect.objectContaining({
        type: "project.vcs-binding.set",
        expectedEpoch: 0,
        binding: jjBinding,
      }),
    ]);
  });

  it("initializes the selected JJ backend when the project has no repository", async () => {
    const initRepository = vi.fn(() => Effect.void);
    const detectRepository = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(null))
      .mockReturnValueOnce(
        Effect.succeed({
          workspaceRoot: "/repo",
          repositoryStorePath: "/store",
          gitStorePath: "/repo",
        }),
      );
    const deps = dependencies({
      project: project({ epoch: 0, binding: null }, "/repo"),
      vcsBackend: "jj",
      jj: { detectRepository, initRepository },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.configureProject({
        projectId: PROJECT_ID,
        expectedEpoch: 0,
      }),
    );

    expect(initRepository).toHaveBeenCalledWith("/repo");
    expect(detectRepository).toHaveBeenCalledTimes(2);
    expect(result.vcs).toEqual({
      epoch: 1,
      binding: {
        backend: "jj",
        repoRoot: "/repo",
        projectRelativePath: ".",
      },
    });
  });

  it("initializes JJ at an existing Git root instead of nesting it in a project subdirectory", async () => {
    const initRepository = vi.fn(() => Effect.void);
    const detectRepository = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(null))
      .mockReturnValueOnce(
        Effect.succeed({
          workspaceRoot: "/repo",
          repositoryStorePath: "/store",
          gitStorePath: "/repo/.git",
        }),
      );
    const deps = dependencies({
      project: project({ epoch: 0, binding: null }),
      vcsBackend: "jj",
      git: {
        execute: () =>
          Effect.succeed({ code: 0, stdout: "/repo\n", stderr: "" }),
      },
      jj: { detectRepository, initRepository },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.configureProject({
        projectId: PROJECT_ID,
        expectedEpoch: 0,
      }),
    );

    expect(initRepository).toHaveBeenCalledWith("/repo");
    expect(result.vcs).toEqual({ epoch: 1, binding: jjBinding });
  });

  it("preserves Git initialization through the first backend selection", async () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce(
        Effect.succeed({ code: 1, stdout: "", stderr: "not a repository" }),
      )
      .mockReturnValueOnce(
        Effect.succeed({ code: 0, stdout: "/repo\n", stderr: "" }),
      );
    const initRepo = vi.fn(() => Effect.void);
    const deps = dependencies({
      project: project({ epoch: 0, binding: null }, "/repo"),
      git: {
        execute,
        initRepo,
        withMutation: (_cwd, effect) => effect,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.configureProject({
        projectId: PROJECT_ID,
        expectedEpoch: 0,
      }),
    );

    expect(initRepo).toHaveBeenCalledWith({ cwd: "/repo" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.vcs).toEqual({
      epoch: 1,
      binding: {
        backend: "git",
        repoRoot: "/repo",
        projectRelativePath: ".",
      },
    });
  });

  it("refuses to initialize Git inside an existing non-colocated JJ workspace", async () => {
    const initRepo = vi.fn(() => Effect.void);
    const deps = dependencies({
      project: project({ epoch: 0, binding: null }),
      git: {
        execute: () =>
          Effect.succeed({ code: 1, stdout: "", stderr: "not a repository" }),
        initRepo,
        withMutation: (_cwd, effect) => effect,
      },
      pathExists: async (path) => path === "/repo/.jj",
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.configureProject({
          projectId: PROJECT_ID,
          expectedEpoch: 0,
        }),
      ),
    ).rejects.toThrow(
      "already inside a JJ workspace without a Git working tree",
    );
    expect(initRepo).not.toHaveBeenCalled();
    expect(deps.dispatched).toHaveLength(0);
  });

  it("initializes JJ lazily when a Git-bound project adopts the global JJ backend", async () => {
    const initRepository = vi.fn(() => Effect.void);
    const detectRepository = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(null))
      .mockReturnValueOnce(
        Effect.succeed({
          workspaceRoot: "/repo",
          repositoryStorePath: "/store",
          gitStorePath: "/repo/.git",
        }),
      );
    const deps = dependencies({
      project: project({
        epoch: 4,
        binding: { ...jjBinding, backend: "git" },
      }),
      vcsBackend: "jj",
      jj: {
        detectRepository,
        initRepository,
      },
      git: {
        execute: () =>
          Effect.succeed({ code: 0, stdout: "/repo\n", stderr: "" }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.configureProject({
          projectId: PROJECT_ID,
          expectedEpoch: 4,
        }),
      ),
    ).resolves.toEqual({ vcs: { epoch: 5, binding: jjBinding } });
    expect(initRepository).toHaveBeenCalledWith("/repo");
    expect(deps.dispatched).toHaveLength(1);
  });

  it("blocks a Git-to-JJ switch while projected worktree threads still exist", async () => {
    const deps = dependencies({
      project: project({
        epoch: 4,
        binding: { ...jjBinding, backend: "git" },
      }),
      vcsBackend: "jj",
      shellThreads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          worktreePath: "/worktrees/existing",
        },
      ],
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/repo",
            repositoryStorePath: "/store",
            gitStorePath: "/repo",
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.configureProject({
          projectId: PROJECT_ID,
          expectedEpoch: 4,
        }),
      ),
    ).rejects.toThrow("Move or remove 1 existing worktree thread");
    expect(deps.dispatched).toHaveLength(0);
  });

  it("blocks a same-backend repository rebind while worktree threads still exist", async () => {
    const deps = dependencies({
      project: project(
        {
          epoch: 4,
          binding: jjBinding,
        },
        "/moved/app",
      ),
      shellThreads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          worktreePath: "/workspaces/existing/app",
        },
      ],
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/moved",
            repositoryStorePath: "/store",
            gitStorePath: "/moved",
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.configureProject({
          projectId: PROJECT_ID,
          expectedEpoch: 4,
        }),
      ),
    ).rejects.toThrow("Move or remove 1 existing worktree thread");
    expect(deps.dispatched).toHaveLength(0);
  });

  it("waits for an in-flight project mutation before switching globally", async () => {
    let releaseCreateBranch: (() => void) | undefined;
    let markCreateBranchStarted: (() => void) | undefined;
    const createBranchStarted = new Promise<void>((resolve) => {
      markCreateBranchStarted = resolve;
    });
    const createBranch = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            releaseCreateBranch = resolve;
            markCreateBranchStarted?.();
          }),
      ),
    );
    const boundProject = project({
      epoch: 4,
      binding: { ...jjBinding, backend: "git" },
    });
    const deps = dependencies({
      project: boundProject,
      vcsBackend: "git",
      commandReadModel: {
        snapshotSequence: 1,
        spaces: [],
        projects: [{ ...boundProject, deletedAt: null }],
        threads: [],
        updatedAt: NOW,
      },
      git: { createBranch },
    });
    const service = makeProjectVcsWith(deps.value);

    const create = Effect.runPromise(
      service.createReference({
        projectId: PROJECT_ID,
        expectedEpoch: 4,
        name: "feature/in-flight",
      }),
    );
    await createBranchStarted;
    const switchBackend = Effect.runPromise(
      service.setBackend({
        backend: "jj",
      }),
    );
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(deps.setVcsBackend).not.toHaveBeenCalled();

    releaseCreateBranch?.();
    await create;
    await switchBackend;
    expect(deps.setVcsBackend).toHaveBeenCalledOnce();
  });

  it("derives a thread workspace cwd and routes status only to JJ", async () => {
    const jjStatus = vi.fn(() =>
      Effect.succeed({
        repository: {
          workspaceRoot: "/workspace",
          repositoryStorePath: "/store",
          gitStorePath: "/repo",
        },
        revision: {
          changeId: "change-1",
          commitId: "commit-1",
          description: "feat: jj",
        },
        currentBookmark: "feature",
        upstreamBookmark: "feature@origin",
        aheadCount: 2,
        behindCount: 1,
        bookmarks: [],
        files: [
          {
            status: "renamed" as const,
            path: "new.ts",
            sourcePath: "old.ts",
            targetPath: "new.ts",
            conflicted: true,
          },
        ],
        hasChanges: true,
        hasConflicts: true,
      }),
    );
    const gitStatus = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "worktree",
        worktreePath: "/workspaces/feature/app",
      },
      gitManager: { status: gitStatus },
      gitHubCli: {
        listOpenPullRequests: () => Effect.succeed([]),
      },
      jj: { status: jjStatus },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.status({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 3,
      }),
    );

    expect(jjStatus).toHaveBeenCalledWith("/workspaces/feature/app");
    expect(gitStatus).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backend: "jj",
      epoch: 3,
      ref: "feature",
      revision: { changeId: "change-1" },
      hasChanges: true,
      hasConflicts: true,
      files: [{ path: "new.ts", sourcePath: "old.ts", conflicted: true }],
      remote: { ref: "feature@origin", aheadCount: 2, behindCount: 1 },
      capabilities: { staging: false, stash: false, checkout: true, workspaces: true },
    });
  });

  it("uses a persisted local working directory as the thread VCS cwd", async () => {
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: null,
        worktreePath: null,
        workingDirectory: "/workspace/studio-folder",
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.resolveTarget({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 3,
      }),
    );

    expect(result.cwd).toBe("/workspace/studio-folder");
  });

  it("uses the thread bookmark to disambiguate JJ bookmarks at the same revision", async () => {
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: "feature-z",
        worktreePath: null,
      },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: null,
            },
            revision: {
              changeId: "working-change",
              commitId: "working-commit",
              description: "",
            },
            currentBookmark: "main",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "main",
                targetChangeId: "base-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "feature-z",
                targetChangeId: "base-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
      },
    });

    const result = await Effect.runPromise(
      makeProjectVcsWith(deps.value).status({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 3,
      }),
    );

    expect(result.ref).toBe("feature-z");
  });

  it("resolves a JJ thread pull request by its recorded URL when the bookmark differs", async () => {
    const listOpenPullRequests = vi.fn(() => Effect.succeed([]));
    const resolvePullRequest = vi.fn(() =>
      Effect.succeed({
        pullRequest: {
          ...pullRequest,
          state: "merged" as const,
        },
      }),
    );
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        worktreePath: null,
        lastKnownPr: pullRequest,
      },
      gitManager: { resolvePullRequest },
      gitHubCli: { listOpenPullRequests },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/workspaces/pr-42",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "change-pr",
              commitId: "commit-pr",
              description: "",
            },
            currentBookmark: "synara/pr-42/head",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.status({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 3,
      }),
    );

    expect(listOpenPullRequests).toHaveBeenCalledWith({
      cwd: "/repo",
      headSelector: "synara/pr-42/head",
      limit: 10,
    });
    expect(resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      reference: pullRequest.url,
    });
    expect(result.pullRequest).toEqual({
      ...pullRequest,
      state: "merged",
    });
  });

  it("does not reuse a recorded pull request for an unrelated JJ bookmark", async () => {
    const resolvePullRequest = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        worktreePath: null,
        lastKnownPr: pullRequest,
      },
      gitManager: { resolvePullRequest },
      gitHubCli: { listOpenPullRequests: () => Effect.succeed([]) },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "other-change",
              commitId: "other-commit",
              description: "",
            },
            currentBookmark: "feature/unrelated",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
      },
    });

    const result = await Effect.runPromise(
      makeProjectVcsWith(deps.value).status({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 3,
      }),
    );

    expect(result.pullRequest).toBeNull();
    expect(resolvePullRequest).not.toHaveBeenCalled();
  });

  it("reports mapped fork status and resolves its owner-qualified pull request", async () => {
    const listOpenPullRequests = vi.fn(
      ({ headSelector }: { headSelector: string }) =>
        Effect.succeed(
          headSelector === "alice:main"
            ? [
                {
                  number: 42,
                  title: "Fork main",
                  url: "https://github.com/example/synara/pull/42",
                  baseRefName: "main",
                  headRefName: "main",
                },
              ]
            : [],
        ),
    );
    const compareBookmarkToRemote = vi.fn(() =>
      Effect.succeed({ aheadCount: 1, behindCount: 0 }),
    );
    const deps = dependencies({
      project: project({ epoch: 3, binding: jjBinding }),
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key.endsWith(".remote")
              ? "alice"
              : key.endsWith(".merge")
                ? "refs/heads/main"
                : key === "remote.alice.url"
                  ? "https://github.com/alice/synara.git"
                  : null,
          ),
      },
      gitHubCli: { listOpenPullRequests },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/git-store",
            },
            revision: {
              changeId: "working-change",
              commitId: "working-commit",
              description: "",
            },
            currentBookmark: "synara/pr-42/main",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "synara/pr-42/main",
                targetChangeId: "local-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "main",
                targetChangeId: "base-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [
                  {
                    name: "alice",
                    targetChangeId: "fork-change",
                    tracked: false,
                    synced: false,
                  },
                ],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        compareBookmarkToRemote,
      },
    });

    const result = await Effect.runPromise(
      makeProjectVcsWith(deps.value).status({
        projectId: PROJECT_ID,
        expectedEpoch: 3,
      }),
    );

    expect(compareBookmarkToRemote).toHaveBeenCalledWith(
      "/repo/app",
      "synara/pr-42/main",
      "alice",
      "main",
    );
    expect(listOpenPullRequests).toHaveBeenCalledWith({
      cwd: "/git-store",
      headSelector: "alice:main",
      limit: 10,
    });
    expect(result).toMatchObject({
      remote: {
        ref: "main@alice",
        aheadCount: 1,
        behindCount: 0,
      },
      pullRequest: {
        number: 42,
        headBranch: "main",
      },
    });
  });

  it("uses the default remote bookmark as a JJ branch-diff base", async () => {
    const readRangeDiff = vi.fn(() =>
      Effect.succeed({ patch: "diff --git", files: [] }),
    );
    const deps = dependencies({
      project: project({ epoch: 2, binding: jjBinding }),
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "feature-change",
              commitId: "feature-commit",
              description: "",
            },
            currentBookmark: "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "feature",
                targetChangeId: "feature-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "main",
                targetChangeId: null,
                isLocal: false,
                current: false,
                conflicted: false,
                remotes: [
                  {
                    name: "origin",
                    targetChangeId: "main-change",
                    tracked: false,
                    synced: false,
                  },
                ],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        readRangeDiff,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.readDiff({
          projectId: PROJECT_ID,
          expectedEpoch: 2,
          scope: "branch",
        }),
      ),
    ).resolves.toEqual({
      backend: "jj",
      epoch: 2,
      patch: "diff --git",
    });
    expect(readRangeDiff).toHaveBeenCalledWith(
      "/repo/app",
      "main@origin",
      "@",
    );
  });

  it("uses the mapped fork head as a JJ branch-diff base", async () => {
    const readRangeDiff = vi.fn(() =>
      Effect.succeed({ patch: "diff --git", files: [] }),
    );
    const deps = dependencies({
      project: project({ epoch: 2, binding: jjBinding }),
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key.endsWith(".remote")
              ? "alice"
              : key.endsWith(".merge")
                ? "refs/heads/main"
                : null,
          ),
      },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/git-store",
            },
            revision: {
              changeId: "working-change",
              commitId: "working-commit",
              description: "",
            },
            currentBookmark: "synara/pr-42/main",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "synara/pr-42/main",
                targetChangeId: "local-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "main",
                targetChangeId: "base-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [
                  {
                    name: "alice",
                    targetChangeId: "fork-change",
                    tracked: false,
                    synced: false,
                  },
                ],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        readRangeDiff,
      },
    });

    await Effect.runPromise(
      makeProjectVcsWith(deps.value).readDiff({
        projectId: PROJECT_ID,
        expectedEpoch: 2,
        scope: "branch",
      }),
    );

    expect(readRangeDiff).toHaveBeenCalledWith(
      "/repo/app",
      "main@alice",
      "@",
    );
  });

  it("rejects staged diff for JJ instead of falling back to Git", async () => {
    const gitDiff = vi.fn();
    const jjDiff = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 2, binding: jjBinding }),
      gitManager: { readWorkingTreeDiff: gitDiff },
      jj: { readRevisionDiff: jjDiff },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.readDiff({
          projectId: PROJECT_ID,
          expectedEpoch: 2,
          scope: "staged",
        }),
      ),
    ).rejects.toThrow("JJ has no staging area");
    expect(gitDiff).not.toHaveBeenCalled();
    expect(jjDiff).not.toHaveBeenCalled();
  });

  it("normalizes JJ bookmarks and workspace registrations", async () => {
    const deps = dependencies({
      project: project({ epoch: 1, binding: jjBinding }),
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "change-1",
              commitId: "commit-1",
              description: "",
            },
            currentBookmark: "feature",
            upstreamBookmark: "feature@origin",
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "main",
                targetChangeId: "main-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [],
              },
              {
                name: "feature",
                targetChangeId: "feature-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [
                  {
                    name: "origin",
                    targetChangeId: "remote-change",
                    tracked: true,
                    synced: false,
                  },
                ],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "feature",
              registration: { kind: "present" as const, root: "/workspaces/feature" },
            },
            {
              name: "gone",
              registration: { kind: "stale" as const },
            },
          ]),
        listGitRemotes: () =>
          Effect.succeed([
            {
              name: "origin",
              url: "git@github.com:example/synara.git",
            },
          ]),
        resolveNearestBookmark: () => Effect.succeed("feature"),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const references = await Effect.runPromise(
      service.listReferences({ projectId: PROJECT_ID, expectedEpoch: 1 }),
    );
    expect(references.references).toEqual([
      expect.objectContaining({ name: "main", isDefault: true, current: false }),
      expect.objectContaining({
        name: "feature",
        current: true,
        workspacePath: "/workspaces/feature/app",
      }),
      expect.objectContaining({
        name: "feature@origin",
        isRemote: true,
        remoteName: "origin",
        tracked: true,
      }),
    ]);
    expect(references.hasOriginRemote).toBe(true);

    const workspaces = await Effect.runPromise(
      service.listWorkspaces({ projectId: PROJECT_ID, expectedEpoch: 1 }),
    );
    expect(workspaces.workspaces).toEqual([
      {
        name: "feature",
        path: "/workspaces/feature/app",
        stale: false,
        current: false,
        ref: "feature",
      },
      {
        name: "gone",
        path: null,
        stale: true,
        current: false,
        ref: null,
      },
    ]);
  });

  it("uses thread metadata to disambiguate a JJ workspace with co-located bookmarks", async () => {
    const deps = dependencies({
      project: project({ epoch: 1, binding: jjBinding }),
      shellThreads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          branch: "feature",
          worktreePath: "/workspaces/feature/app",
        },
      ],
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "working-change",
              commitId: "working-commit",
              description: "",
            },
            currentBookmark: "main",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "main",
                targetChangeId: "shared-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "feature",
                targetChangeId: "shared-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "feature",
              registration: {
                kind: "present" as const,
                root: "/workspaces/feature",
              },
            },
          ]),
        resolveNearestBookmark: () => Effect.succeed("main"),
      },
    });

    const references = await Effect.runPromise(
      makeProjectVcsWith(deps.value).listReferences({
        projectId: PROJECT_ID,
        expectedEpoch: 1,
      }),
    );

    expect(
      references.references.find((reference) => reference.name === "main"),
    ).toMatchObject({ workspacePath: null });
    expect(
      references.references.find((reference) => reference.name === "feature"),
    ).toMatchObject({ workspacePath: "/workspaces/feature/app" });
  });

  it("resolves a JJ workspace source in the caller workspace without invoking Git", async () => {
    const createJjWorkspace = vi.fn((input: Parameters<JjCoreShape["createWorkspace"]>[0]) =>
      Effect.succeed({
        name: input.workspaceName,
        path: input.workspacePath,
        revision: {
          changeId: "workspace-change",
          commitId: "workspace-commit",
          description: input.message,
        },
      }),
    );
    const createGitWorktree = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 5, binding: jjBinding }),
      git: { createDetachedWorktree: createGitWorktree },
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "current-change",
              commitId: "current-commit",
              description: "",
            },
            currentBookmark: "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        readRevisionIdentity: (_cwd, revision) =>
          Effect.succeed({
            changeId: `${revision}-change`,
            commitId: `${revision}-commit`,
            description: "",
          }),
        createWorkspace: createJjWorkspace,
        getWorkspaceRegistration: () => Effect.succeed({ kind: "absent" as const }),
        forgetWorkspace: () => Effect.void,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.createWorkspace({
        projectId: PROJECT_ID,
        expectedEpoch: 5,
        sourceRef: "main",
        path: null,
        copyChangesFromCurrent: false,
      }),
    );

    expect(createJjWorkspace).toHaveBeenCalledWith({
      repositoryPath: "/repo",
      workspacePath: "/managed/abc123/synara",
      workspaceName: "synara-abc123",
      revision: "main-commit",
      message: "wip: Synara workspace synara-abc123",
    });
    expect(createGitWorktree).not.toHaveBeenCalled();
    expect(result).toEqual({
      backend: "jj",
      epoch: 5,
      workspace: {
        name: "synara-abc123",
        path: "/managed/abc123/synara/app",
        ref: "workspace-commit",
        branch: null,
      },
    });
  });

  it("rejects a JJ copy request whose source is not the current change", async () => {
    const createWorkspace = vi.fn();
    const removeDirectory = vi.fn(async () => undefined);
    const deps = dependencies({
      project: project({ epoch: 5, binding: jjBinding }),
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "current-change",
              commitId: "current-commit",
              description: "",
            },
            currentBookmark: "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: true,
            hasConflicts: false,
          }),
        readRevisionIdentity: () =>
          Effect.succeed({
            changeId: "main-change",
            commitId: "main-commit",
            description: "",
          }),
        createWorkspace,
      },
      removeDirectory,
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.createWorkspace({
          projectId: PROJECT_ID,
          expectedEpoch: 5,
          sourceRef: "main",
          path: null,
          copyChangesFromCurrent: true,
        }),
      ),
    ).rejects.toThrow("only when the source revision resolves to the current change");
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(removeDirectory).toHaveBeenCalledWith("/managed/abc123");
  });

  it("creates and publishes a JJ bookmark without replacing the current change", async () => {
    const createBookmark = vi.fn(() => Effect.void);
    const pushBookmark = vi.fn(() => Effect.void);
    const startNewChange = vi.fn();
    const gitCreateBranch = vi.fn();
    const gitCheckout = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 7, binding: jjBinding }),
      git: {
        createBranch: gitCreateBranch,
        checkout: gitCheckout,
      },
      jj: {
        createBookmark,
        pushBookmark,
        startNewChange,
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "current-change",
              commitId: "current-commit",
              description: "",
            },
            currentBookmark: "main",
            upstreamBookmark: "main@origin",
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "main",
                targetChangeId: "base-change",
                isLocal: true,
                current: true,
                conflicted: false,
                remotes: [],
              },
              {
                name: "feature",
                targetChangeId: "base-change",
                isLocal: true,
                current: false,
                conflicted: false,
                remotes: [],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.createReference({
          projectId: PROJECT_ID,
          expectedEpoch: 7,
          name: "feature",
          publish: true,
        }),
      ),
    ).resolves.toEqual({ backend: "jj", epoch: 7, ref: "feature" });
    await expect(
      Effect.runPromise(
        service.switchReference({
          projectId: PROJECT_ID,
          expectedEpoch: 7,
          ref: "feature",
        }),
      ),
    ).resolves.toEqual({
      backend: "jj",
      epoch: 7,
      ref: "feature",
      revision: {
        changeId: "current-change",
        commitId: "current-commit",
        description: "",
      },
    });

    expect(createBookmark).toHaveBeenCalledWith("/repo/app", "feature", "@-");
    expect(pushBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "feature",
      "origin",
    );
    expect(startNewChange).not.toHaveBeenCalled();
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitCheckout).not.toHaveBeenCalled();
  });

  it("publishes the JJ base before attaching a new bookmark to dirty @", async () => {
    const createBookmark = vi.fn(() => Effect.void);
    const pushBookmark = vi.fn(() => Effect.void);
    const setBookmark = vi.fn(() => Effect.void);
    const deps = dependencies({
      project: project({ epoch: 7, binding: jjBinding }),
      jj: {
        createBookmark,
        pushBookmark,
        setBookmark,
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "dirty-change",
              commitId: "dirty-commit",
              description: "wip",
            },
            currentBookmark: "main",
            upstreamBookmark: "main@origin",
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [
              {
                status: "modified",
                path: "src/app.ts",
                sourcePath: "src/app.ts",
                targetPath: "src/app.ts",
                conflicted: false,
              },
            ],
            hasChanges: true,
            hasConflicts: false,
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await Effect.runPromise(
      service.createReference({
        projectId: PROJECT_ID,
        expectedEpoch: 7,
        name: "feature",
        publish: true,
      }),
    );

    expect(createBookmark).toHaveBeenCalledWith("/repo/app", "feature", "@-");
    expect(pushBookmark).toHaveBeenCalledWith("/repo/app", "feature", "origin");
    expect(setBookmark).toHaveBeenCalledWith("/repo/app", "feature", "@");
  });

  it("tracks a remote-only JJ bookmark before switching to it", async () => {
    const trackBookmark = vi.fn(() => Effect.void);
    const startNewChange = vi.fn(() =>
      Effect.succeed({
        changeId: "remote-child-change",
        commitId: "remote-child-commit",
        description: "wip: Synara on remote-feature",
      }),
    );
    const deps = dependencies({
      project: project({ epoch: 7, binding: jjBinding }),
      jj: {
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/repo",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "current-change",
              commitId: "current-commit",
              description: "",
            },
            currentBookmark: "main",
            upstreamBookmark: "main@origin",
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [
              {
                name: "remote-feature",
                targetChangeId: "remote-change",
                isLocal: false,
                current: false,
                conflicted: false,
                remotes: [
                  {
                    name: "origin",
                    targetChangeId: "remote-change",
                    tracked: false,
                    synced: false,
                  },
                ],
              },
            ],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        trackBookmark,
        startNewChange,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.switchReference({
          projectId: PROJECT_ID,
          expectedEpoch: 7,
          ref: "remote-feature@origin",
        }),
      ),
    ).resolves.toMatchObject({
      backend: "jj",
      epoch: 7,
      ref: "remote-feature",
    });
    expect(trackBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "remote-feature@origin",
    );
    expect(startNewChange).toHaveBeenCalledWith(
      "/repo/app",
      "remote-feature",
      "wip: Synara on remote-feature",
    );
  });

  it("refuses to remove a dirty JJ workspace unless force is explicit", async () => {
    const forgetWorkspace = vi.fn();
    const removeDirectory = vi.fn(async () => undefined);
    const deps = dependencies({
      project: project({ epoch: 6, binding: jjBinding }),
      jj: {
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "feature",
              registration: {
                kind: "present" as const,
                root: "/workspaces/feature",
              },
            },
          ]),
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/workspaces/feature",
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision: {
              changeId: "change",
              commitId: "commit",
              description: "",
            },
            currentBookmark: "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: true,
            hasConflicts: false,
          }),
        forgetWorkspace,
      },
      removeDirectory,
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.removeWorkspace({
          projectId: PROJECT_ID,
          expectedEpoch: 6,
          path: "/workspaces/feature/app",
        }),
      ),
    ).rejects.toThrow("has changes or conflicts");
    expect(forgetWorkspace).not.toHaveBeenCalled();
    expect(removeDirectory).not.toHaveBeenCalled();
  });

  it("maps workspace-shaped VCS handoffs to the native Git worktree API", async () => {
    const gitHandoff = vi.fn(() =>
      Effect.succeed({
        targetMode: "worktree" as const,
        branch: "feature",
        worktreePath: "/managed/feature",
        associatedWorktreePath: "/managed/feature",
        associatedWorktreeBranch: "feature",
        associatedWorktreeRef: "feature",
        changesTransferred: true,
        conflictsDetected: false,
        message: "Moved",
      }),
    );
    const deps = dependencies({
      project: project({
        epoch: 7,
        binding: { ...jjBinding, backend: "git" },
      }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: "main",
        worktreePath: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
      },
      gitManager: { handoffThread: gitHandoff },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.handoffThread({
        commandId: CommandId.makeUnsafe("cmd-git-handoff-workspace"),
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 7,
        targetMode: "workspace",
        preferredLocalReference: null,
        preferredWorkspaceBaseReference: "main",
        preferredNewWorkspaceName: "feature",
      }),
    );

    expect(gitHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/app",
        targetMode: "worktree",
        preferredWorktreeBaseBranch: "main",
        preferredNewWorktreeName: "feature",
      }),
    );
    expect(result).toEqual({
      backend: "git",
      epoch: 7,
      targetMode: "workspace",
      branch: "feature",
      workspacePath: "/managed/feature/app",
      associatedWorkspacePath: "/managed/feature/app",
      associatedWorkspaceBranch: "feature",
      associatedWorkspaceRef: "feature",
      changesTransferred: true,
      conflictsDetected: false,
      message: "Moved",
    });
  });

  it("hands a local thread into a JJ workspace without invoking Git", async () => {
    const createBookmark = vi.fn(() => Effect.void);
    const startNewChange = vi.fn(() =>
      Effect.succeed({
        changeId: "local-continuation",
        commitId: "local-continuation-commit",
        description: "wip: Synara local workspace continuation",
      }),
    );
    const gitHandoff = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 8, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "local",
        branch: null,
        worktreePath: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
      },
      gitManager: { handoffThread: gitHandoff },
      jj: {
        status: (cwd) =>
          Effect.succeed({
            repository: {
              workspaceRoot: cwd,
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision:
              cwd === "/repo/app"
                ? {
                    changeId: "source-change",
                    commitId: "source-commit",
                    description: "wip: source",
                  }
                : {
                    changeId: "workspace-change",
                    commitId: "workspace-commit",
                    description: "wip: workspace",
                  },
            currentBookmark: cwd === "/repo/app" ? "main" : "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: cwd === "/repo/app",
            hasConflicts: false,
          }),
        createWorkspace: (workspaceInput) =>
          Effect.succeed({
            name: workspaceInput.workspaceName,
            path: workspaceInput.workspacePath,
            revision: {
              changeId: "workspace-change",
              commitId: "workspace-commit",
              description: workspaceInput.message,
            },
          }),
        getWorkspaceRegistration: () => Effect.succeed({ kind: "absent" as const }),
        forgetWorkspace: () => Effect.void,
        createBookmark,
        startNewChange,
        resolveNearestBookmark: () => Effect.succeed("feature"),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.handoffThread({
        commandId: CommandId.makeUnsafe("cmd-jj-handoff-workspace"),
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 8,
        targetMode: "workspace",
        preferredLocalReference: null,
        preferredWorkspaceBaseReference: "feature",
        preferredNewWorkspaceName: "feature",
      }),
    );

    expect(createBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "feature",
      "source-commit",
    );
    expect(startNewChange).toHaveBeenCalledWith(
      "/repo/app",
      "source-commit",
      "wip: Synara local workspace continuation",
    );
    expect(gitHandoff).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backend: "jj",
      epoch: 8,
      targetMode: "workspace",
      branch: "feature",
      workspacePath: "/managed/abc123/synara/app",
      associatedWorkspaceRef: "workspace-commit",
      changesTransferred: true,
      conflictsDetected: false,
    });
  });

  it("merges a JJ thread workspace into local before forgetting it", async () => {
    const execute = vi.fn(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const forgetWorkspace = vi.fn(() => Effect.void);
    const removeDirectory = vi.fn(async () => undefined);
    const deps = dependencies({
      project: project({ epoch: 9, binding: jjBinding }),
      thread: {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        envMode: "worktree",
        branch: "feature",
        worktreePath: "/workspaces/feature/app",
        associatedWorktreePath: "/workspaces/feature/app",
        associatedWorktreeBranch: "feature",
        associatedWorktreeRef: "source-commit",
      },
      jj: {
        status: (cwd) =>
          Effect.succeed({
            repository: {
              workspaceRoot: cwd,
              repositoryStorePath: "/store",
              gitStorePath: "/repo",
            },
            revision:
              cwd === "/workspaces/feature/app"
                ? {
                    changeId: "source-change",
                    commitId: "source-commit",
                    description: "wip: source",
                  }
                : {
                    changeId: "merge-change",
                    commitId: "merge-commit",
                    description: "wip: merge",
                  },
            currentBookmark: "feature",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: cwd === "/workspaces/feature/app",
            hasConflicts: false,
          }),
        readRevisionIdentity: () =>
          Effect.succeed({
            changeId: "local-change",
            commitId: "local-commit",
            description: "wip: local",
          }),
        withMutation: (_cwd, effect) => effect,
        execute,
        resolveNearestBookmark: () => Effect.succeed("feature"),
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "feature-workspace",
              registration: {
                kind: "present" as const,
                root: "/workspaces/feature",
              },
            },
          ]),
        forgetWorkspace,
      },
      removeDirectory,
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.handoffThread({
        commandId: CommandId.makeUnsafe("cmd-jj-handoff-local"),
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        expectedEpoch: 9,
        targetMode: "local",
        preferredLocalReference: "feature",
        preferredWorkspaceBaseReference: null,
        preferredNewWorkspaceName: null,
      }),
    );

    expect(execute).toHaveBeenCalledWith({
      operation: "ProjectVcs.handoffThread.mergeIntoLocal",
      cwd: "/repo/app",
      args: [
        "new",
        "--message",
        "wip: Synara JJ workspace handoff",
        "source-change",
        "local-change",
      ],
    });
    expect(forgetWorkspace).toHaveBeenCalledWith("/repo", "feature-workspace");
    expect(removeDirectory).toHaveBeenCalledWith("/workspaces/feature");
    expect(result).toMatchObject({
      backend: "jj",
      epoch: 9,
      targetMode: "local",
      workspacePath: null,
      associatedWorkspacePath: "/workspaces/feature/app",
      changesTransferred: true,
      conflictsDetected: false,
    });
  });

  it("maps workspace-shaped PR preparation to the native Git worktree API", async () => {
    const preparePullRequestThread = vi.fn(() =>
      Effect.succeed({
        pullRequest,
        branch: "feature/jj",
        worktreePath: "/managed/pr/app",
      }),
    );
    const deps = dependencies({
      project: project({
        epoch: 10,
        binding: { ...jjBinding, backend: "git" },
      }),
      gitManager: { preparePullRequestThread },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.preparePullRequestThread({
        projectId: PROJECT_ID,
        expectedEpoch: 10,
        reference: "#42",
        mode: "workspace",
      }),
    );

    expect(preparePullRequestThread).toHaveBeenCalledWith({
      cwd: "/repo/app",
      reference: "#42",
      mode: "worktree",
    });
    expect(result).toEqual({
      backend: "git",
      epoch: 10,
      pullRequest,
      branch: "feature/jj",
      workspacePath: "/managed/pr/app",
    });
  });

  it("resolves a pull request through the JJ Git backing store", async () => {
    const resolvePullRequest = vi.fn(() =>
      Effect.succeed({ pullRequest }),
    );
    const deps = dependencies({
      project: project({ epoch: 10, binding: jjBinding }),
      gitManager: { resolvePullRequest },
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/repo",
            repositoryStorePath: "/store",
            gitStorePath: "/git-store",
          }),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.resolvePullRequest({
        projectId: PROJECT_ID,
        expectedEpoch: 10,
        reference: "#42",
      }),
    );
    const remoteCwd = await Effect.runPromise(
      service.remoteGitCwd({
        projectId: PROJECT_ID,
        expectedEpoch: 10,
      }),
    );

    expect(resolvePullRequest).toHaveBeenCalledWith({
      cwd: "/git-store",
      reference: "#42",
    });
    expect(result).toEqual({
      backend: "jj",
      epoch: 10,
      pullRequest,
    });
    expect(remoteCwd).toBe("/git-store");
  });

  it("imports a PR head before starting a local JJ change", async () => {
    const operations: string[] = [];
    const materializePullRequestHead = vi.fn(() =>
      Effect.sync(() => {
        operations.push("materialize");
        return { pullRequest, branch: "feature/jj" };
      }),
    );
    const importGit = vi.fn(() =>
      Effect.sync(() => {
        operations.push("import");
      }),
    );
    const listBookmarks = vi.fn(() =>
      Effect.sync(() => {
        operations.push("bookmarks");
        return [
          {
            name: "feature/jj",
            targetChangeId: "change-pr",
            isLocal: true,
            current: false,
            conflicted: false,
            remotes: [],
          },
        ];
      }),
    );
    const startNewChange = vi.fn(() =>
      Effect.sync(() => {
        operations.push("new");
        return {
          changeId: "change-working",
          commitId: "commit-working",
          description: "wip: Synara pull request #42",
        };
      }),
    );
    const deps = dependencies({
      project: project({ epoch: 11, binding: jjBinding }),
      gitManager: { materializePullRequestHead },
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/repo",
            repositoryStorePath: "/store",
            gitStorePath: "/git-store",
          }),
        importGit,
        listBookmarks,
        readRevisionIdentity: () =>
          Effect.sync(() => {
            operations.push("revision");
            return {
              changeId: "change-pr",
              commitId: "commit-pr",
              description: "PR head",
            };
          }),
        startNewChange,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.preparePullRequestThread({
        projectId: PROJECT_ID,
        expectedEpoch: 11,
        reference: "#42",
        mode: "local",
      }),
    );

    expect(materializePullRequestHead).toHaveBeenCalledWith({
      cwd: "/git-store",
      reference: "#42",
    });
    expect(importGit).toHaveBeenCalledWith("/repo/app");
    expect(startNewChange).toHaveBeenCalledWith(
      "/repo/app",
      "feature/jj",
      "wip: Synara pull request #42",
    );
    expect(operations).toEqual([
      "materialize",
      "import",
      "bookmarks",
      "revision",
      "new",
    ]);
    expect(result).toEqual({
      backend: "jj",
      epoch: 11,
      pullRequest,
      branch: "feature/jj",
      workspacePath: null,
    });
  });

  it("normalizes a cross-fork PR head into a tracked JJ bookmark", async () => {
    const crossForkPullRequest = {
      ...pullRequest,
      headBranch: "feature/fork",
    };
    const createBookmark = vi.fn(() => Effect.void);
    const trackBookmark = vi.fn(() => Effect.void);
    const deleteBookmark = vi.fn(() => Effect.void);
    const startNewChange = vi.fn(() =>
      Effect.succeed({
        changeId: "change-working",
        commitId: "commit-working",
        description: "wip: Synara pull request #42",
      }),
    );
    const deps = dependencies({
      project: project({ epoch: 11, binding: jjBinding }),
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key ===
              "branch.synara/pr-42/feature-fork.remote"
              ? "alice"
              : null,
          ),
      },
      gitManager: {
        materializePullRequestHead: () =>
          Effect.succeed({
            pullRequest: crossForkPullRequest,
            branch: "synara/pr-42/feature-fork",
          }),
      },
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/repo",
            repositoryStorePath: "/store",
            gitStorePath: "/git-store",
          }),
        importGit: () => Effect.void,
        listBookmarks: () =>
          Effect.succeed([
            {
              name: "synara/pr-42/feature-fork",
              targetChangeId: "change-pr",
              isLocal: true,
              current: false,
              conflicted: false,
              remotes: [],
            },
            {
              name: "feature/fork",
              targetChangeId: null,
              isLocal: false,
              current: false,
              conflicted: false,
              remotes: [
                {
                  name: "backup",
                  targetChangeId: "change-pr",
                  tracked: false,
                  synced: false,
                },
                {
                  name: "alice",
                  targetChangeId: "change-pr",
                  tracked: false,
                  synced: false,
                },
              ],
            },
          ]),
        readRevisionIdentity: () =>
          Effect.succeed({
            changeId: "change-pr",
            commitId: "commit-pr",
            description: "PR head",
          }),
        createBookmark,
        trackBookmark,
        deleteBookmark,
        startNewChange,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.preparePullRequestThread({
        projectId: PROJECT_ID,
        expectedEpoch: 11,
        reference: "#42",
        mode: "local",
      }),
    );

    expect(createBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "feature/fork",
      "synara/pr-42/feature-fork",
    );
    expect(trackBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "feature/fork@alice",
    );
    expect(deleteBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "synara/pr-42/feature-fork",
    );
    expect(startNewChange).toHaveBeenCalledWith(
      "/repo/app",
      "feature/fork",
      "wip: Synara pull request #42",
    );
    expect(result).toEqual({
      backend: "jj",
      epoch: 11,
      pullRequest: crossForkPullRequest,
      branch: "feature/fork",
      workspacePath: null,
    });
  });

  it("reuses an existing JJ workspace for the imported PR bookmark", async () => {
    const createWorkspace = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 12, binding: jjBinding }),
      shellThreads: [
        {
          id: THREAD_ID,
          projectId: PROJECT_ID,
          branch: "feature/jj",
          worktreePath: "/workspaces/pr/app",
        },
      ],
      pathExists: async (path) => path === "/workspaces/pr/app",
      gitManager: {
        materializePullRequestHead: () =>
          Effect.succeed({ pullRequest, branch: "feature/jj" }),
      },
      jj: {
        detectRepository: () =>
          Effect.succeed({
            workspaceRoot: "/repo",
            repositoryStorePath: "/store",
            gitStorePath: "/git-store",
          }),
        importGit: () => Effect.void,
        listBookmarks: () =>
          Effect.succeed([
            {
              name: "feature/jj",
              targetChangeId: "change-pr",
              isLocal: true,
              current: false,
              conflicted: false,
              remotes: [],
            },
          ]),
        readRevisionIdentity: () =>
          Effect.succeed({
            changeId: "change-pr",
            commitId: "commit-pr",
            description: "PR head",
          }),
        listWorkspaces: () =>
          Effect.succeed([
            {
              name: "pr-42",
              registration: {
                kind: "present" as const,
                root: "/workspaces/pr",
              },
            },
          ]),
        resolveNearestBookmark: () => Effect.succeed("main"),
        status: () =>
          Effect.succeed({
            repository: {
              workspaceRoot: "/workspaces/pr",
              repositoryStorePath: "/store",
              gitStorePath: "/git-store",
            },
            revision: {
              changeId: "change-working",
              commitId: "commit-working",
              description: "",
            },
            currentBookmark: "feature/jj",
            upstreamBookmark: null,
            aheadCount: 0,
            behindCount: 0,
            bookmarks: [],
            files: [],
            hasChanges: false,
            hasConflicts: false,
          }),
        createWorkspace,
      },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.preparePullRequestThread({
        projectId: PROJECT_ID,
        expectedEpoch: 12,
        reference: "#42",
        mode: "workspace",
      }),
    );

    expect(createWorkspace).not.toHaveBeenCalled();
    expect(result).toEqual({
      backend: "jj",
      epoch: 12,
      pullRequest,
      branch: "feature/jj",
      workspacePath: "/workspaces/pr/app",
    });
  });

  it("routes pull through the configured JJ backend", async () => {
    const baseStatus = {
      repository: {
        workspaceRoot: "/repo",
        repositoryStorePath: "/store",
        gitStorePath: "/repo/.git",
      },
      revision: {
        changeId: "change-1",
        commitId: "commit-1",
        description: "",
      },
      currentBookmark: "feature",
      upstreamBookmark: "feature@origin",
      aheadCount: 0,
      behindCount: 0,
      bookmarks: [],
      files: [],
      hasChanges: false,
      hasConflicts: false,
    } as const;
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(baseStatus))
      .mockReturnValueOnce(
        Effect.succeed({ ...baseStatus, behindCount: 2 }),
      );
    const fetchGit = vi.fn(() => Effect.void);
    const advanceBookmark = vi.fn(() => Effect.void);
    const gitPull = vi.fn();
    const deps = dependencies({
      project: project({ epoch: 10, binding: jjBinding }),
      git: { pullCurrentBranch: gitPull },
      jj: { status, fetchGit, advanceBookmark },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.pull({
        projectId: PROJECT_ID,
        expectedEpoch: 10,
      }),
    );

    expect(fetchGit).toHaveBeenCalledWith("/repo/app", "origin");
    expect(advanceBookmark).toHaveBeenCalledWith(
      "/repo/app",
      "feature",
      "origin",
      "feature",
    );
    expect(gitPull).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backend: "jj",
      status: "pulled",
      ref: "feature",
    });
  });

  it("derives the project cwd before delegating a Git stacked action", async () => {
    const runStackedAction = vi.fn(() =>
      Effect.succeed({
        action: "push" as const,
        branch: { status: "skipped_not_requested" as const },
        commit: { status: "skipped_not_requested" as const },
        push: {
          status: "pushed" as const,
          branch: "feature",
          upstreamBranch: "origin/feature",
          setUpstream: false,
        },
        pr: { status: "skipped_not_requested" as const },
      }),
    );
    const deps = dependencies({
      project: project({
        epoch: 11,
        binding: { ...jjBinding, backend: "git" },
      }),
      gitManager: { runStackedAction },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.runStackedAction({
        projectId: PROJECT_ID,
        expectedEpoch: 11,
        actionId: "project-git-action",
        action: "push",
      }),
    );

    expect(runStackedAction).toHaveBeenCalledWith(
      {
        actionId: "project-git-action",
        action: "push",
        cwd: "/repo/app",
      },
      undefined,
    );
    expect(result.push.status).toBe("pushed");
  });
});
