import {
  ProjectId,
  type GitActionProgressEvent,
  type VcsRunStackedActionInput,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";
import type { TextGenerationShape } from "../git/Services/TextGeneration.ts";
import type { JjCoreShape, JjWorkingCopyStatus } from "./Services/JjCore.ts";
import { makeJjActions } from "./jjActions.ts";

const PROJECT_ID = ProjectId.makeUnsafe("jj-actions-project");

function workingCopy(overrides: Partial<JjWorkingCopyStatus> = {}): JjWorkingCopyStatus {
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
    nearestBookmarkDistance: null,
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

function crossForkWorkingCopy(synced: boolean): JjWorkingCopyStatus {
  const localTarget = "change-local";
  return workingCopy({
    currentBookmark: "synara/pr-42/main",
    nearestBookmarkDistance: null,
    upstreamBookmark: null,
    bookmarks: [
      {
        name: "synara/pr-42/main",
        targetChangeId: localTarget,
        isLocal: true,
        current: true,
        conflicted: false,
        remotes: [],
      },
      {
        name: "main",
        targetChangeId: "change-main",
        isLocal: true,
        current: false,
        conflicted: false,
        remotes: [
          {
            name: "alice",
            targetChangeId: synced ? localTarget : "change-fork",
            tracked: false,
            synced: false,
          },
        ],
      },
    ],
  });
}

function actionInput(overrides: Partial<VcsRunStackedActionInput> = {}): VcsRunStackedActionInput {
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
  git?: Partial<GitCoreShape>;
  gitHubCli?: Partial<GitHubCliShape>;
  textGeneration?: Partial<TextGenerationShape>;
}) {
  return makeJjActions({
    jj: input.jj as JjCoreShape,
    git: {
      readConfigValue: () => Effect.succeed(null),
      ...(input.git ?? {}),
    } as GitCoreShape,
    gitHubCli: (input.gitHubCli ?? {}) as GitHubCliShape,
    textGeneration: (input.textGeneration ?? {}) as TextGenerationShape,
  });
}

describe("JJ actions", () => {
  it("uses the thread-preferred bookmark when JJ has several nearest bookmarks", async () => {
    const pushBookmark = vi.fn(() => Effect.void);
    const before = workingCopy({
      currentBookmark: "main",
      nearestBookmarkDistance: null,
      upstreamBookmark: null,
      bookmarks: [
        {
          name: "main",
          targetChangeId: "change-base",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [],
        },
        {
          name: "feature-z",
          targetChangeId: "change-base",
          isLocal: true,
          current: false,
          conflicted: false,
          remotes: [],
        },
      ],
    });
    const after = workingCopy({
      currentBookmark: "main",
      nearestBookmarkDistance: null,
      upstreamBookmark: null,
      bookmarks: [
        before.bookmarks[0]!,
        {
          ...before.bookmarks[1]!,
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
      .mockReturnValueOnce(Effect.succeed(before))
      .mockReturnValueOnce(Effect.succeed(before))
      .mockReturnValueOnce(Effect.succeed(after));
    const service = actions({
      jj: { status, pushBookmark },
    });

    const result = await Effect.runPromise(
      service.runStackedAction(
        {
          cwd: "/repo",
          epoch: 3,
          preferredBookmark: "feature-z",
        },
        actionInput(),
      ),
    );

    expect(pushBookmark).toHaveBeenCalledWith("/repo", "feature-z");
    expect(result.push).toMatchObject({
      status: "pushed",
      branch: "feature-z",
    });
  });

  it("fetches and fast-forwards a behind-only tracked bookmark", async () => {
    const fetchGit = vi.fn(() => Effect.void);
    const advanceBookmark = vi.fn(() => Effect.void);
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(workingCopy()))
      .mockReturnValueOnce(Effect.succeed(workingCopy({ behindCount: 2 })));
    const service = actions({
      jj: { status, fetchGit, advanceBookmark },
    });

    const result = await Effect.runPromise(service.pull({ cwd: "/repo", epoch: 3 }));

    expect(fetchGit).toHaveBeenCalledWith("/repo", "origin");
    expect(advanceBookmark).toHaveBeenCalledWith("/repo", "feature", "origin", "feature");
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
          .mockReturnValueOnce(Effect.succeed(workingCopy({ aheadCount: 1, behindCount: 1 }))),
        fetchGit: () => Effect.void,
      },
    });
    await expect(Effect.runPromise(diverged.pull({ cwd: "/repo", epoch: 3 }))).rejects.toThrow(
      "diverged",
    );

    const advanceBookmark = vi.fn(() => Effect.void);
    const localAhead = actions({
      jj: {
        status: vi
          .fn()
          .mockReturnValueOnce(Effect.succeed(workingCopy()))
          .mockReturnValueOnce(Effect.succeed(workingCopy({ aheadCount: 1, behindCount: 0 }))),
        fetchGit: () => Effect.void,
        advanceBookmark,
      },
    });
    const result = await Effect.runPromise(localAhead.pull({ cwd: "/repo", epoch: 3 }));

    expect(result.status).toBe("skipped_up_to_date");
    expect(advanceBookmark).not.toHaveBeenCalled();
  });

  it("pulls a colliding cross-fork bookmark from its mapped remote head", async () => {
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(crossForkWorkingCopy(false)))
      .mockReturnValueOnce(Effect.succeed(crossForkWorkingCopy(false)));
    const fetchGit = vi.fn(() => Effect.void);
    const compareBookmarkToRemote = vi.fn(() => Effect.succeed({ aheadCount: 0, behindCount: 1 }));
    const advanceBookmark = vi.fn(() => Effect.void);
    const service = actions({
      jj: {
        status,
        fetchGit,
        compareBookmarkToRemote,
        advanceBookmark,
      },
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key.endsWith(".remote") ? "alice" : key.endsWith(".merge") ? "refs/heads/main" : null,
          ),
      },
    });

    const result = await Effect.runPromise(service.pull({ cwd: "/repo", epoch: 3 }));

    expect(fetchGit).toHaveBeenCalledWith("/repo", "alice");
    expect(compareBookmarkToRemote).toHaveBeenCalledWith(
      "/repo",
      "synara/pr-42/main",
      "alice",
      "main",
    );
    expect(advanceBookmark).toHaveBeenCalledWith("/repo", "synara/pr-42/main", "alice", "main");
    expect(result).toEqual({
      backend: "jj",
      epoch: 3,
      status: "pulled",
      ref: "synara/pr-42/main",
      upstreamRef: "main@alice",
    });
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
        readRevisionDiff: () => Effect.succeed({ patch: "diff --git", files: dirty.files }),
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

    expect(commitWorkingCopy).toHaveBeenCalledWith("/repo", "feat: native jj", ["src/a.ts"]);
    expect(setBookmark).toHaveBeenCalledWith("/repo", "feature", "commit-committed");
    expect(pushBookmark).toHaveBeenCalledWith("/repo", "feature", "origin");
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
      nearestBookmarkDistance: null,
      upstreamBookmark: null,
      bookmarks: [],
    });
    const afterCreate = workingCopy({
      currentBookmark: "feature/feat-generated",
      nearestBookmarkDistance: null,
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
      nearestBookmarkDistance: null,
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

    expect(createBookmark).toHaveBeenCalledWith("/repo", "feature/feat-generated", "@-");
    expect(pushBookmark).toHaveBeenCalledWith("/repo", "feature/feat-generated");
  });

  it("uses the explicit Git remote fallback for a colliding cross-fork bookmark", async () => {
    const before = crossForkWorkingCopy(false);
    const after = crossForkWorkingCopy(true);
    const status = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(before))
      .mockReturnValueOnce(Effect.succeed(before))
      .mockReturnValueOnce(Effect.succeed(after));
    const jjExecute = vi.fn<JjCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const gitExecute = vi.fn(() => Effect.succeed({ code: 0, stdout: "", stderr: "" }));
    const pushBookmark = vi.fn();
    const service = actions({
      jj: {
        status,
        withMutation: (_cwd, effect) => effect,
        execute: jjExecute,
        pushBookmark,
      },
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(
            key.endsWith(".remote") ? "alice" : key.endsWith(".merge") ? "refs/heads/main" : null,
          ),
        execute: gitExecute,
      },
    });

    const result = await Effect.runPromise(
      service.runStackedAction({ cwd: "/repo", epoch: 3 }, actionInput({ action: "push" })),
    );

    expect(pushBookmark).not.toHaveBeenCalled();
    expect(jjExecute.mock.calls.map(([input]) => input.operation)).toEqual([
      "JjActions.pushRemoteFallback.export",
      "JjActions.pushRemoteFallback.import",
    ]);
    expect(gitExecute).toHaveBeenCalledWith({
      operation: "JjActions.pushRemoteFallback.push",
      cwd: "/repo/.git",
      args: ["push", "--porcelain", "alice", "refs/heads/synara/pr-42/main:refs/heads/main"],
    });
    expect(result.push).toEqual({
      status: "pushed",
      branch: "synara/pr-42/main",
      upstreamBranch: "main@alice",
      setUpstream: false,
    });
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
      service.runStackedAction({ cwd: "/repo", epoch: 3 }, actionInput({ action: "create_pr" })),
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

  it("uses owner-qualified GitHub selectors for a tracked fork bookmark", async () => {
    const fork = workingCopy({
      currentBookmark: "feature/fork",
      nearestBookmarkDistance: null,
      upstreamBookmark: "feature/fork@alice",
      bookmarks: [
        {
          name: "feature/fork",
          targetChangeId: "change-fork",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [
            {
              name: "alice",
              targetChangeId: "change-fork",
              tracked: true,
              synced: true,
            },
          ],
        },
      ],
    });
    const listOpenPullRequests = vi.fn(({ headSelector }: { headSelector: string }) =>
      Effect.succeed(
        headSelector === "alice:feature/fork"
          ? [
              {
                number: 44,
                title: "Fork JJ",
                url: "https://github.com/acme/repo/pull/44",
                baseRefName: "main",
                headRefName: "feature/fork",
              },
            ]
          : [],
      ),
    );
    const service = actions({
      jj: { status: () => Effect.succeed(fork) },
      git: {
        readConfigValue: (_cwd, key) =>
          Effect.succeed(key === "remote.alice.url" ? "git@github.com:alice/repo.git" : null),
      },
      gitHubCli: { listOpenPullRequests },
    });

    const result = await Effect.runPromise(
      service.runStackedAction({ cwd: "/repo", epoch: 3 }, actionInput({ action: "create_pr" })),
    );

    expect(listOpenPullRequests).toHaveBeenCalledWith({
      cwd: "/repo/.git",
      headSelector: "alice:feature/fork",
      limit: 10,
    });
    expect(result.pr).toMatchObject({
      status: "opened_existing",
      number: 44,
      headBranch: "feature/fork",
    });
  });

  it("diffs a fork PR against the base repository remote", async () => {
    const fork = workingCopy({
      currentBookmark: "feature/fork",
      nearestBookmarkDistance: null,
      upstreamBookmark: "feature/fork@alice",
      bookmarks: [
        {
          name: "feature/fork",
          targetChangeId: "change-fork",
          isLocal: true,
          current: true,
          conflicted: false,
          remotes: [
            {
              name: "alice",
              targetChangeId: "change-fork",
              tracked: true,
              synced: true,
            },
          ],
        },
      ],
    });
    const readRangeDiff = vi.fn(() => Effect.succeed({ patch: "diff --git", files: [] }));
    const createPullRequest = vi.fn(() => Effect.void);
    const service = actions({
      jj: {
        status: () => Effect.succeed(fork),
        listBookmarks: () =>
          Effect.succeed([
            ...fork.bookmarks,
            {
              name: "main",
              targetChangeId: "change-main",
              isLocal: true,
              current: false,
              conflicted: false,
              remotes: [
                {
                  name: "alice",
                  targetChangeId: "change-fork-main",
                  tracked: false,
                  synced: false,
                },
                {
                  name: "origin",
                  targetChangeId: "change-main",
                  tracked: true,
                  synced: true,
                },
              ],
            },
          ]),
        readRangeDiff,
        readRevisionIdentity: () =>
          Effect.succeed({
            changeId: "change-fork",
            commitId: "commit-fork",
            description: "feat: fork",
          }),
      },
      git: {
        readConfigValue: () => Effect.succeed("https://github.com/alice/repo.git"),
      },
      gitHubCli: {
        listOpenPullRequests: () => Effect.succeed([]),
        getDefaultBranch: () => Effect.succeed("main"),
        createPullRequest,
      },
      textGeneration: {
        generatePrContent: () => Effect.succeed({ title: "Fork PR", body: "Body" }),
      },
    });

    await Effect.runPromise(
      service.runStackedAction({ cwd: "/repo", epoch: 3 }, actionInput({ action: "create_pr" })),
    );

    expect(readRangeDiff).toHaveBeenCalledWith("/repo", "main@origin", "feature/fork");
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "main",
        headSelector: "alice:feature/fork",
      }),
    );
  });
});
