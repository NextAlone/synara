import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { ProjectId, type OrchestrationThread } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { GitCoreShape } from "./git/Services/GitCore.ts";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  listProjectedManagedWorkspaces,
  listManagedWorktrees,
  MANAGED_WORKTREE_RETENTION_COUNT,
  pruneArchivedManagedWorktrees,
} from "./managedWorktrees.ts";
import type { ProjectVcsShape } from "./vcs/Services/ProjectVcs.ts";

const temporaryRoots: string[] = [];

async function makeManagedRoot(count: number) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-"));
  temporaryRoots.push(root);
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const worktreePath = path.join(root, `task-${index}`, "synara");
    await fs.mkdir(worktreePath, { recursive: true });
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/repo/.git/worktrees/test\n");
    paths.push(await fs.realpath(worktreePath));
  }
  return { root, paths };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe("managed worktrees", () => {
  it("lists managed Git and JJ workspaces through each project's selected backend", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-vcs-workspaces-"));
    temporaryRoots.push(root);
    const gitPath = path.join(root, "git", "synara");
    const jjPath = path.join(root, "jj", "synara");
    await fs.mkdir(gitPath, { recursive: true });
    await fs.mkdir(jjPath, { recursive: true });
    const gitProjectId = ProjectId.makeUnsafe("project-git");
    const jjProjectId = ProjectId.makeUnsafe("project-jj");
    const projects = [
      {
        id: gitProjectId,
        kind: "project",
        title: "Git",
        workspaceRoot: "/repo/git",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        vcs: {
          epoch: 2,
          binding: {
            backend: "git",
            repoRoot: "/repo/git",
            projectRelativePath: ".",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: jjProjectId,
        kind: "project",
        title: "JJ",
        workspaceRoot: "/repo/jj",
        defaultModelSelection: null,
        scripts: [],
        isPinned: false,
        vcs: {
          epoch: 4,
          binding: {
            backend: "jj",
            repoRoot: "/repo/jj",
            projectRelativePath: ".",
          },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ] as const;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          spaces: [],
          projects,
          threads: [],
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
    } as unknown as ProjectionSnapshotQueryShape;
    const projectVcs = {
      listWorkspaces: ({ projectId }: { readonly projectId: ProjectId }) =>
        Effect.succeed({
          backend: projectId === gitProjectId ? ("git" as const) : ("jj" as const),
          epoch: projectId === gitProjectId ? 2 : 4,
          workspaces: [
            {
              name: "primary",
              path: projectId === gitProjectId ? "/repo/git" : "/repo/jj",
              stale: false,
              current: true,
              ref: null,
            },
            {
              name: "managed",
              path: projectId === gitProjectId ? gitPath : jjPath,
              stale: false,
              current: false,
              ref: null,
            },
          ],
        }),
    } as unknown as ProjectVcsShape;

    await expect(
      Effect.runPromise(
        listProjectedManagedWorkspaces({
          worktreesDir: root,
          snapshotQuery,
          projectVcs,
        }),
      ),
    ).resolves.toEqual([
      {
        projectId: gitProjectId,
        backend: "git",
        epoch: 2,
        path: await fs.realpath(gitPath),
        workspaceRoot: "/repo/git",
      },
      {
        projectId: jjProjectId,
        backend: "jj",
        epoch: 4,
        path: await fs.realpath(jjPath),
        workspaceRoot: "/repo/jj",
      },
    ]);
  });

  it("discovers linked worktrees and reports their primary checkout", async () => {
    const { root, paths } = await makeManagedRoot(2);
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
    } as unknown as GitCoreShape;

    await expect(
      Effect.runPromise(listManagedWorktrees({ worktreesDir: root, git })),
    ).resolves.toEqual(
      paths.map((worktreePath) => ({ path: worktreePath, workspaceRoot: "/repo/project" })),
    );
  });

  it("snapshots and removes only archived worktrees beyond the retention limit", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const snapshots: string[] = [];
    const removals: string[] = [];
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      snapshotWorktree: ({ outputPath }: { outputPath: string }) =>
        Effect.sync(() => snapshots.push(outputPath)),
      removeWorktree: ({ path: worktreePath }: { path: string }) =>
        Effect.sync(() => removals.push(worktreePath)),
    } as unknown as GitCoreShape;
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath,
          associatedWorktreePath: worktreePath,
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        }) as unknown as OrchestrationThread,
    );
    const snapshotsDir = path.join(root, "snapshots");

    const remaining = await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir,
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toContain(path.join(root, "snapshots", "thread-0-"));
    expect(remaining).toHaveLength(MANAGED_WORKTREE_RETENTION_COUNT);
  });

  it("matches threads whose recorded paths reach the worktree through a symlink", async () => {
    const count = MANAGED_WORKTREE_RETENTION_COUNT + 1;
    const { root, paths } = await makeManagedRoot(count);
    const canonicalRoot = await fs.realpath(root);
    const linkRoot = await fs.mkdtemp(path.join(tmpdir(), "synara-managed-worktrees-link-"));
    temporaryRoots.push(linkRoot);
    const symlinkedRoot = path.join(linkRoot, "worktrees");
    await fs.symlink(canonicalRoot, symlinkedRoot);
    const removals: string[] = [];
    const git = {
      execute: ({ cwd }: { cwd: string }) =>
        Effect.succeed({
          code: 0,
          stdout: `worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n\nworktree ${cwd}\nHEAD abc\ndetached\n`,
          stderr: "",
        }),
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      snapshotWorktree: () => Effect.void,
      removeWorktree: ({ path: worktreePath }: { path: string }) =>
        Effect.sync(() => removals.push(worktreePath)),
    } as unknown as GitCoreShape;
    // Threads recorded their worktrees through the symlinked directory, while
    // the inventory scan reports realpath-canonical entries.
    const threads = paths.map(
      (worktreePath, index) =>
        ({
          id: `thread-${index}`,
          worktreePath: path.join(symlinkedRoot, path.relative(canonicalRoot, worktreePath)),
          associatedWorktreePath: path.join(
            symlinkedRoot,
            path.relative(canonicalRoot, worktreePath),
          ),
          archivedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        }) as unknown as OrchestrationThread,
    );

    await Effect.runPromise(
      pruneArchivedManagedWorktrees({
        worktreesDir: root,
        snapshotsDir: path.join(root, "snapshots"),
        threads,
        git,
      }),
    );

    expect(removals).toEqual([paths[0]]);
  });
});
