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
import type { GitManagerShape } from "../../git/Services/GitManager.ts";
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
  jj?: Partial<JjCoreShape>;
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
      jj: input.jj ?? {},
      orchestrationEngine,
      projection,
      canonicalizePath: async (path: string) => path,
      now: () => NOW,
      makeCommandId: () => CommandId.makeUnsafe("cmd-project-vcs-service"),
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
      capabilities: { staging: false, stash: false, checkout: false, workspaces: true },
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
});
