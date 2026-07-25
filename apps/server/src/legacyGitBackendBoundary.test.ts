import * as nodePath from "node:path";

import { ProjectId, ThreadId, WS_METHODS } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeLegacyGitBackendBoundary } from "./legacyGitBackendBoundary.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-jj");

function makeBoundary(input?: {
  readonly selectedBackend?: "git" | "jj";
  readonly backend?: "git" | "jj" | null;
  readonly projectRelativePath?: string;
  readonly worktreePath?: string | null;
  readonly gitStorePath?: string | null;
  readonly canonicalPaths?: Readonly<Record<string, string>>;
}) {
  const backend = input?.backend === undefined ? "jj" : input.backend;
  return makeLegacyGitBackendBoundary({
    getVcsBackend: Effect.succeed(input?.selectedBackend ?? "jj"),
    snapshotQuery: {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [
            {
              id: PROJECT_ID,
              kind: "project",
              title: "JJ project",
              workspaceRoot: "/repo/packages/app",
              defaultModelSelection: null,
              scripts: [],
              isPinned: false,
              vcs: {
                epoch: 3,
                binding:
                  backend === null
                    ? null
                    : {
                        backend,
                        repoRoot: "/repo",
                        projectRelativePath: input?.projectRelativePath ?? "packages/app",
                      },
              },
              createdAt: "2026-07-25T00:00:00.000Z",
              updatedAt: "2026-07-25T00:00:00.000Z",
            },
          ],
          threads: [
            {
              id: ThreadId.makeUnsafe("thread-jj"),
              projectId: PROJECT_ID,
              worktreePath: input?.worktreePath ?? null,
              associatedWorktreePath: null,
            },
          ],
          updatedAt: "2026-07-25T00:00:00.000Z",
        } as never),
    } as never,
    canonicalizePath: (path) =>
      Effect.succeed(input?.canonicalPaths?.[path] ?? nodePath.resolve(path)),
    resolveJjGitStorePath: () =>
      Effect.succeed(input?.gitStorePath ?? null),
  });
}

describe("legacy Git backend boundary", () => {
  it("blocks local Git access anywhere inside a JJ repository", async () => {
    const assertAllowed = makeBoundary();

    await expect(
      Effect.runPromise(
        assertAllowed({
          method: WS_METHODS.gitStatus,
          cwd: "/repo/packages/app/src",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
  });

  it("blocks a stale Git project binding while JJ is selected globally", async () => {
    await expect(
      Effect.runPromise(
        makeBoundary({ backend: "git" })({
          method: WS_METHODS.gitStatus,
          cwd: "/repo/packages/app/src",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
  });

  it("blocks local Git access through a canonicalized alias", async () => {
    const assertAllowed = makeBoundary({
      canonicalPaths: {
        "/alias/app": "/repo/packages/app",
      },
    });

    await expect(
      Effect.runPromise(
        assertAllowed({
          method: WS_METHODS.gitCheckout,
          cwd: "/alias/app",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
  });

  it("derives and protects the repository root of a JJ subproject workspace", async () => {
    const assertAllowed = makeBoundary({
      worktreePath: "/managed/workspace/packages/app",
    });

    await expect(
      Effect.runPromise(
        assertAllowed({
          method: WS_METHODS.gitStageFiles,
          cwd: "/managed/workspace/packages/app",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
  });

  it("protects an external JJ Git store from legacy local Git RPCs", async () => {
    const assertAllowed = makeBoundary({
      gitStorePath: "/shared/jj/store/git",
    });

    await expect(
      Effect.runPromise(
        assertAllowed({
          method: WS_METHODS.gitRunStackedAction,
          cwd: "/shared/jj/store/git",
        }),
      ),
    ).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
  });

  it.each([
    WS_METHODS.gitGithubRepository,
    WS_METHODS.gitResolvePullRequest,
    WS_METHODS.gitPullRequestSnapshot,
  ])("allows the explicit JJ remote-read fallback %s", async (method) => {
    const assertAllowed = makeBoundary();

    await expect(
      Effect.runPromise(assertAllowed({ method, cwd: "/repo/packages/app" })),
    ).resolves.toBeUndefined();
  });

  it("allows legacy Git calls when Git is selected globally and for unrelated paths", async () => {
    await expect(
      Effect.runPromise(
        makeBoundary({ selectedBackend: "git", backend: "git" })({
          method: WS_METHODS.gitStatus,
          cwd: "/repo/packages/app",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        makeBoundary({ selectedBackend: "git", backend: null })({
          method: WS_METHODS.gitInit,
          cwd: "/repo/packages/app",
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      Effect.runPromise(
        makeBoundary()({
          method: WS_METHODS.gitStatus,
          cwd: "/other/repo",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
