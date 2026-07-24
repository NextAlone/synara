import {
  ProjectId,
  type GitActionProgressEvent,
  type VcsRunStackedActionInput,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import type { TextGenerationShape } from "../git/Services/TextGeneration.ts";
import type {
  JjCoreShape,
  JjWorkingCopyStatus,
} from "./Services/JjCore.ts";
import { makeJjActions } from "./jjActions.ts";

const PROJECT_ID = ProjectId.makeUnsafe("jj-actions-project");

function workingCopy(
  overrides: Partial<JjWorkingCopyStatus> = {},
): JjWorkingCopyStatus {
  return {
    repository: {
      workspaceRoot: "/repo",
      repositoryStorePath: "/repo/.jj/repo",
      gitStorePath: "/repo/.git",
    },
    revision: {
      changeId: "change-working",
      commitId: "commit-working",
      description: "",
    },
    currentBookmark: "feature",
    upstreamBookmark: "feature@origin",
    aheadCount: 0,
    behindCount: 0,
    bookmarks: [
      {
        name: "feature",
        targetChangeId: "change-feature",
        isLocal: true,
        current: true,
        conflicted: false,
        remotes: [
          {
            name: "origin",
            targetChangeId: "change-feature",
            tracked: true,
            synced: true,
          },
        ],
      },
    ],
    files: [],
    hasChanges: false,
    hasConflicts: false,
    ...overrides,
  };
}

function actionInput(
  overrides: Partial<VcsRunStackedActionInput> = {},
): VcsRunStackedActionInput {
  return {
    projectId: PROJECT_ID,
    expectedEpoch: 3,
    actionId: "jj-action-1",
    action: "push",
    ...overrides,
  };
}

function actions(input: {
  jj: Partial<JjCoreShape>;
  gitHubCli?: Partial<GitHubCliShape>;
  textGeneration?: Partial<TextGenerationShape>;
}) {
  return makeJjActions({
    jj: input.jj as JjCoreShape,
    gitHubCli: (input.gitHubCli ?? {}) as GitHubCliShape,
    textGeneration: (input.textGeneration ?? {}) as TextGenerationShape,
  });
}

describe("JJ actions", () => {
  it("fetches and fast-forwards a behind-only tracked bookmark", async () => {
    const fetchGit = vi.fn(() => Effect.void);
    const advanceBookmark = vi.fn(() => Effect.void);
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(workingCopy()))
      .mockReturnValueOnce(
        Effect.succeed(workingCopy({ behindCount: 2 })),
      );
    const service = actions({
      jj: { status, fetchGit, advanceBookmark },
    });

    const result = await Effect.runPromise(
      service.pull({ cwd: "/repo", epoch: 3 }),
    );

    expect(fetchGit).toHaveBeenCalledWith("/repo", "origin");
    expect(advanceBookmark).toHaveBeenCalledWith(
      "/repo",
      "feature",
      "origin",
    );
    expect(result).toEqual({
      backend: "jj",
      epoch: 3,
      status: "pulled",
      ref: "feature",
      upstreamRef: "feature@origin",
    });
  });

  it("rejects a diverged bookmark but treats local-ahead-only as up to date", async () => {
    const diverged = actions({
      jj: {
        status: vi
          .fn()
          .mockReturnValueOnce(Effect.succeed(workingCopy()))
          .mockReturnValueOnce(
            Effect.succeed(
              workingCopy({ aheadCount: 1, behindCount: 1 }),
            ),
          ),
        fetchGit: () => Effect.void,
      },
    });
    await expect(
      Effect.runPromise(diverged.pull({ cwd: "/repo", epoch: 3 })),
    ).rejects.toThrow("diverged");

    const advanceBookmark = vi.fn(() => Effect.void);
    const localAhead = actions({
      jj: {
        status: vi
          .fn()
          .mockReturnValueOnce(Effect.succeed(workingCopy()))
          .mockReturnValueOnce(
            Effect.succeed(
              workingCopy({ aheadCount: 1, behindCount: 0 }),
            ),
          ),
        fetchGit: () => Effect.void,
        advanceBookmark,
      },
    });
    const result = await Effect.runPromise(
      localAhead.pull({ cwd: "/repo", epoch: 3 }),
    );

    expect(result.status).toBe("skipped_up_to_date");
    expect(advanceBookmark).not.toHaveBeenCalled();
  });

  it("commits selected files, advances the bookmark, and pushes through JJ", async () => {
    const dirty = workingCopy({
      files: [
        {
          status: "modified",
          path: "src/a.ts",
          sourcePath: "src/a.ts",
          targetPath: "src/a.ts",
          conflicted: false,
        },
      ],
      hasChanges: true,
      aheadCount: 1,
      bookmarks: [
        {
          name: "feature",
          targetChangeId: "change-old",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [
            {
              name: "origin",
              targetChangeId: "change-remote",
              tracked: true,
              synced: false,
            },
          ],
        },
      ],
    });
    const cleanUnsynced = workingCopy({
      revision: {
        changeId: "change-next",
        commitId: "commit-next",
        description: "",
      },
      bookmarks: dirty.bookmarks,
    });
    const cleanSynced = workingCopy();
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(dirty))
      .mockReturnValueOnce(Effect.succeed(cleanUnsynced))
      .mockReturnValueOnce(Effect.succeed(cleanUnsynced))
      .mockReturnValueOnce(Effect.succeed(cleanSynced));
    const commitWorkingCopy = vi.fn(() =>
      Effect.succeed({
        changeId: "change-committed",
        commitId: "commit-committed",
        description: "feat: native jj",
      }),
    );
    const setBookmark = vi.fn(() => Effect.void);
    const pushBookmark = vi.fn(() => Effect.void);
    const progress: GitActionProgressEvent[] = [];
    const service = actions({
      jj: {
        status,
        readRevisionDiff: () =>
          Effect.succeed({ patch: "diff --git", files: dirty.files }),
        commitWorkingCopy,
        setBookmark,
        pushBookmark,
      },
    });

    const result = await Effect.runPromise(
      service.runStackedAction(
        { cwd: "/repo", epoch: 3 },
        actionInput({
          action: "commit_push",
          commitMessage: "feat: native jj",
          filePaths: ["src/a.ts"],
        }),
        {
          publishProgress: (event) =>
            Effect.sync(() => {
              progress.push(event);
            }),
        },
      ),
    );

    expect(commitWorkingCopy).toHaveBeenCalledWith(
      "/repo",
      "feat: native jj",
      ["src/a.ts"],
    );
    expect(setBookmark).toHaveBeenCalledWith(
      "/repo",
      "feature",
      "commit-committed",
    );
    expect(pushBookmark).toHaveBeenCalledWith("/repo", "feature");
    expect(result).toMatchObject({
      commit: { status: "created", commitSha: "commit-committed" },
      push: {
        status: "pushed",
        branch: "feature",
        upstreamBranch: "feature@origin",
      },
    });
    expect(progress.at(-1)?.kind).toBe("action_finished");
  });

  it("creates feature bookmarks at the committed parent, never at dirty @", async () => {
    const createBookmark = vi.fn(() => Effect.void);
    const pushBookmark = vi.fn(() => Effect.void);
    const initial = workingCopy({
      currentBookmark: null,
      upstreamBookmark: null,
      bookmarks: [],
    });
    const afterCreate = workingCopy({
      currentBookmark: "feature/feat-generated",
      upstreamBookmark: null,
      bookmarks: [
        {
          name: "feature/feat-generated",
          targetChangeId: "change-base",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [],
        },
      ],
    });
    const afterPush = workingCopy({
      currentBookmark: "feature/feat-generated",
      upstreamBookmark: "feature/feat-generated@origin",
      bookmarks: [
        {
          name: "feature/feat-generated",
          targetChangeId: "change-base",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [
            {
              name: "origin",
              targetChangeId: "change-base",
              tracked: true,
              synced: true,
            },
          ],
        },
      ],
    });
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(initial))
      .mockReturnValueOnce(Effect.succeed(afterCreate))
      .mockReturnValueOnce(Effect.succeed(afterPush));
    const service = actions({
      jj: {
        status,
        listBookmarks: () => Effect.succeed([]),
        createBookmark,
        pushBookmark,
      },
    });

    await Effect.runPromise(
      service.runStackedAction(
        { cwd: "/repo", epoch: 3 },
        actionInput({
          action: "push",
          featureBranch: true,
          commitMessage: "feat: generated",
        }),
      ),
    );

    expect(createBookmark).toHaveBeenCalledWith(
      "/repo",
      "feature/feat-generated",
      "@-",
    );
    expect(pushBookmark).toHaveBeenCalledWith(
      "/repo",
      "feature/feat-generated",
    );
  });

  it("uses GitHub CLI only for remote PR metadata and creation", async () => {
    const listOpenPullRequests = vi.fn(() =>
      Effect.succeed([
        {
          number: 42,
          title: "Native JJ",
          url: "https://github.com/acme/repo/pull/42",
          baseRefName: "main",
          headRefName: "feature",
        },
      ]),
    );
    const pushBookmark = vi.fn();
    const service = actions({
      jj: {
        status: () => Effect.succeed(workingCopy()),
        pushBookmark,
      },
      gitHubCli: { listOpenPullRequests },
    });

    const result = await Effect.runPromise(
      service.runStackedAction(
        { cwd: "/repo", epoch: 3 },
        actionInput({ action: "create_pr" }),
      ),
    );

    expect(listOpenPullRequests).toHaveBeenCalledWith({
      cwd: "/repo/.git",
      headSelector: "feature",
      limit: 10,
    });
    expect(pushBookmark).not.toHaveBeenCalled();
    expect(result.pr).toEqual({
      status: "opened_existing",
      url: "https://github.com/acme/repo/pull/42",
      number: 42,
      baseBranch: "main",
      headBranch: "feature",
      title: "Native JJ",
    });
  });
});
