import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { JjWorkingCopyStatus } from "./Services/JjCore.ts";
import { resolveJjBookmarkRemote, resolveJjGitHubHeadContext } from "./jjRemote.ts";

function crossForkStatus(): JjWorkingCopyStatus {
  return {
    repository: {
      workspaceRoot: "/repo",
      repositoryStorePath: "/repo/.jj/repo",
      gitStorePath: "/repo/.git",
    },
    revision: {
      changeId: "working",
      commitId: "working-commit",
      description: "",
    },
    currentBookmark: "synara/pr-42/main",
    nearestBookmarkDistance: null,
    upstreamBookmark: null,
    aheadCount: 0,
    behindCount: 0,
    bookmarks: [
      {
        name: "synara/pr-42/main",
        targetChangeId: "fork-change",
        isLocal: true,
        current: true,
        conflicted: false,
        remotes: [],
      },
      {
        name: "main",
        targetChangeId: "local-main-change",
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
  };
}

describe("JJ remote resolution", () => {
  it("resolves the Git bridge mapping used by a colliding cross-fork PR", async () => {
    const readConfigValue = vi.fn((_cwd: string, key: string) =>
      Effect.succeed(
        key.endsWith(".remote")
          ? "alice"
          : key.endsWith(".merge")
            ? "refs/heads/main"
            : "https://github.com/alice/synara.git",
      ),
    );
    const git = { readConfigValue } as unknown as GitCoreShape;
    const status = crossForkStatus();

    const remote = await Effect.runPromise(
      resolveJjBookmarkRemote({
        git,
        status,
        bookmark: "synara/pr-42/main",
      }),
    );
    const head = await Effect.runPromise(
      resolveJjGitHubHeadContext({
        git,
        gitCwd: "/repo/.git",
        bookmark: "synara/pr-42/main",
        remote,
      }),
    );

    expect(remote).toEqual({
      localBookmark: "synara/pr-42/main",
      remoteName: "alice",
      remoteBookmark: "main",
      remoteRevision: "main@alice",
      tracked: false,
      synced: true,
      nativePush: false,
    });
    expect(head).toEqual({
      headBranch: "main",
      selectors: ["alice:main", "main", "synara/pr-42/main"],
      preferredSelector: "alice:main",
    });
  });

  it("prefers JJ's tracked same-name remote without consulting Git config", async () => {
    const readConfigValue = vi.fn();
    const base = crossForkStatus();
    const status: JjWorkingCopyStatus = {
      ...base,
      bookmarks: [
        {
          ...base.bookmarks[0]!,
          remotes: [
            {
              name: "fork",
              targetChangeId: "fork-change",
              tracked: true,
              synced: true,
            },
          ],
        },
        ...base.bookmarks.slice(1),
      ],
    };

    const remote = await Effect.runPromise(
      resolveJjBookmarkRemote({
        git: { readConfigValue } as unknown as GitCoreShape,
        status,
        bookmark: "synara/pr-42/main",
      }),
    );

    expect(remote).toMatchObject({
      remoteName: "fork",
      remoteBookmark: "synara/pr-42/main",
      nativePush: true,
    });
    expect(readConfigValue).not.toHaveBeenCalled();
  });
});
