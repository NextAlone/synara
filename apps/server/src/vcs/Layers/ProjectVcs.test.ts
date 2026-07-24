import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationProjectShell,
  type ProjectVcsBinding,
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
  thread?: Record<string, unknown> | null;
  shellThreads?: ReadonlyArray<Record<string, unknown>>;
  git?: Partial<GitCoreShape>;
  gitManager?: Partial<GitManagerShape>;
  gitHubCli?: Partial<GitHubCliShape>;
  textGeneration?: Partial<TextGenerationShape>;
  jj?: Partial<JjCoreShape>;
  removeDirectory?: (path: string) => Promise<void>;
}) {
  const dispatched: unknown[] = [];
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
    value: {
      git: input.git ?? {},
      gitManager: input.gitManager ?? {},
      gitHubCli: input.gitHubCli ?? {},
      textGeneration: input.textGeneration ?? {},
      jj: input.jj ?? {},
      orchestrationEngine,
      projection,
      canonicalizePath: async (path: string) => path,
      now: () => NOW,
      makeCommandId: () => CommandId.makeUnsafe("cmd-project-vcs-service"),
      worktreesDir: "/managed",
      pathExists: async () => false,
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

describe("ProjectVcs", () => {
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
      git: { execute: gitExecute },
      jj: { detectRepository: jjDetect },
    });
    const service = makeProjectVcsWith(deps.value);

    const result = await Effect.runPromise(
      service.setBackend({
        projectId: PROJECT_ID,
        backend: "jj",
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

  it("blocks a Git-to-JJ switch while projected worktree threads still exist", async () => {
    const deps = dependencies({
      project: project({
        epoch: 4,
        binding: { ...jjBinding, backend: "git" },
      }),
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
        service.setBackend({
          projectId: PROJECT_ID,
          backend: "jj",
          expectedEpoch: 4,
        }),
      ),
    ).rejects.toThrow("Move or remove 1 existing worktree thread");
    expect(deps.dispatched).toHaveLength(0);
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

    const workspaces = await Effect.runPromise(
      service.listWorkspaces({ projectId: PROJECT_ID, expectedEpoch: 1 }),
    );
    expect(workspaces.workspaces).toEqual([
      {
        name: "feature",
        path: "/workspaces/feature/app",
        stale: false,
        current: false,
        ref: null,
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

  it("creates a JJ workspace from the current change without invoking Git", async () => {
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
        copyChangesFromCurrent: true,
      }),
    );

    expect(createJjWorkspace).toHaveBeenCalledWith({
      repositoryPath: "/repo",
      workspacePath: "/managed/abc123/synara",
      workspaceName: "synara-abc123",
      revision: "@",
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

  it("creates and switches JJ bookmarks without invoking Git", async () => {
    const createBookmark = vi.fn(() => Effect.void);
    const startNewChange = vi.fn(() =>
      Effect.succeed({
        changeId: "next-change",
        commitId: "next-commit",
        description: "wip: Synara on feature",
      }),
    );
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
        startNewChange,
        resolveNearestBookmark: () => Effect.succeed("feature"),
      },
    });
    const service = makeProjectVcsWith(deps.value);

    await expect(
      Effect.runPromise(
        service.createReference({
          projectId: PROJECT_ID,
          expectedEpoch: 7,
          name: "feature",
          publish: false,
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
        changeId: "next-change",
        commitId: "next-commit",
        description: "wip: Synara on feature",
      },
    });

    expect(createBookmark).toHaveBeenCalledWith("/repo/app", "feature", "@");
    expect(startNewChange).toHaveBeenCalledWith(
      "/repo/app",
      "feature",
      "wip: Synara on feature",
    );
    expect(gitCreateBranch).not.toHaveBeenCalled();
    expect(gitCheckout).not.toHaveBeenCalled();
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

  it("hands a local thread into a JJ workspace without invoking Git", async () => {
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
            currentBookmark: "feature",
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
        targetMode: "worktree",
        preferredLocalReference: null,
        preferredWorkspaceBaseReference: "feature",
        preferredNewWorkspaceName: "feature",
      }),
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
      targetMode: "worktree",
      branch: "feature",
      worktreePath: "/managed/abc123/synara/app",
      associatedWorktreeRef: "workspace-commit",
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
      worktreePath: null,
      associatedWorktreePath: "/workspaces/feature/app",
      changesTransferred: true,
      conflictsDetected: false,
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
