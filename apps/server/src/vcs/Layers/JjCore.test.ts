import { Effect } from "effect";
import * as nodePath from "node:path";
import { describe, expect, it } from "vitest";

import type { ExecuteJjInput, ExecuteJjResult, JjCoreShape } from "../Services/JjCore.ts";
import { makeJjCore } from "./JjCore.ts";

function result(stdout = "", stderr = "", code = 0): ExecuteJjResult {
  return { code, stdout, stderr };
}

describe("JjCore", () => {
  it("decodes stale workspace roots without treating jj template errors as malformed output", async () => {
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      return Effect.succeed(
        result(
          [
            '"default"',
            '"/repo"',
            '"gone"',
            "<Error: Workspace has no recorded path: gone>",
            "",
          ].join("\0"),
        ),
      );
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    await expect(Effect.runPromise(core.listWorkspaces("/repo"))).resolves.toEqual([
      { name: "default", registration: { kind: "present", root: "/repo" } },
      { name: "gone", registration: { kind: "stale" } },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--ignore-working-copy");
    expect(calls[0]?.args.at(-1)).toContain("\\0");
  });

  it("snapshots status once and makes dependent reads ignore the working copy", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (input.operation === "JjCore.status.files") {
        return Effect.succeed(
          result(
            '{"status":"modified","sourcePath":"src/a.ts","targetPath":"src/a.ts","conflicted":false}\n',
          ),
        );
      }
      if (input.operation === "JjCore.readRevisionIdentity") {
        return Effect.succeed(
          result('{"changeId":"change-1","commitId":"commit-1","description":"feat: current"}\n'),
        );
      }
      if (input.operation === "JjCore.detectRepository.root") {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.detectRepository.gitRoot") {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.listBookmarks") {
        return Effect.succeed(
          result(
            [
              '{"name":"feature","remote":null,"tracked":false,"synced":true,"conflicted":false,"targetChangeId":"change-1"}',
              '{"name":"synara-checkpoint/legacy","remote":null,"tracked":false,"synced":true,"conflicted":false,"targetChangeId":"change-1"}',
              '{"name":"synara-snapshot/catalog","remote":null,"tracked":false,"synced":true,"conflicted":false,"targetChangeId":"change-1"}',
            ].join("\n"),
          ),
        );
      }
      if (input.operation === "JjCore.resolveNearestBookmark") {
        return Effect.succeed(result('{"name":"feature"}\n'));
      }
      if (input.operation === "JjCore.status.nearestBookmarkDistance") {
        return Effect.succeed(result("change-2\nchange-3\n"));
      }
      return Effect.die(new Error(`Unexpected operation ${input.operation}`));
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const status = await Effect.runPromise(core.status(repositoryRoot));

    expect(status).toMatchObject({
      revision: { changeId: "change-1", commitId: "commit-1" },
      currentBookmark: "feature",
      nearestBookmarkDistance: {
        bookmark: "feature",
        nonEmptyChangeCount: 2,
      },
      upstreamBookmark: null,
      aheadCount: 0,
      behindCount: 0,
      hasChanges: true,
      hasConflicts: false,
      bookmarks: [{ name: "feature", current: true }],
      files: [{ path: "src/a.ts", status: "modified" }],
    });
    expect(calls[0]?.operation).toBe("JjCore.status.files");
    expect(calls[0]?.args).not.toContain("--ignore-working-copy");
    for (const call of calls.slice(1)) {
      expect(call.args).toContain("--ignore-working-copy");
    }
    const nearestBookmarkRevset = calls
      .find((call) => call.operation === "JjCore.resolveNearestBookmark")
      ?.args.join(" ");
    expect(nearestBookmarkRevset).toContain("synara-checkpoint/*");
    expect(nearestBookmarkRevset).toContain("synara-snapshot/*");
    expect(
      calls
        .find((call) => call.operation === "JjCore.status.nearestBookmarkDistance")
        ?.args.join(" "),
    ).toContain('bookmarks(exact:"feature")..@ & ~empty()');
  });

  it("reads the patch from the same snapshot as its file list", async () => {
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (input.operation === "JjCore.readRevisionDiff.files") {
        return Effect.succeed(
          result(
            '{"status":"added","sourcePath":"new.txt","targetPath":"new.txt","conflicted":false}\n',
          ),
        );
      }
      if (input.operation === "JjCore.readRevisionDiff.patch") {
        return Effect.succeed(result("diff --git a/new.txt b/new.txt\n"));
      }
      return Effect.die(new Error(`Unexpected operation ${input.operation}`));
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const diff = await Effect.runPromise(core.readRevisionDiff("/repo", "@", ["new.txt"]));

    expect(diff.patch).toContain("diff --git");
    expect(diff.files).toEqual([
      {
        status: "added",
        path: "new.txt",
        sourcePath: "new.txt",
        targetPath: "new.txt",
        conflicted: false,
      },
    ]);
    expect(calls[0]?.args).not.toContain("--ignore-working-copy");
    expect(calls[1]?.args).toContain("--ignore-working-copy");
    expect(calls[0]?.args.slice(-2)).toEqual(["--", "new.txt"]);
    expect(calls[1]?.args.slice(-2)).toEqual(["--", "new.txt"]);
  });

  it("compares a tracked local bookmark with its remote bookmark", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      switch (input.operation) {
        case "JjCore.status.files":
          return Effect.succeed(result());
        case "JjCore.readRevisionIdentity":
          return Effect.succeed(
            result('{"changeId":"change-1","commitId":"commit-1","description":""}\n'),
          );
        case "JjCore.detectRepository.root":
        case "JjCore.detectRepository.gitRoot":
          return Effect.succeed(result(repositoryRoot));
        case "JjCore.listBookmarks":
          return Effect.succeed(
            result(
              [
                '{"name":"feature","remote":null,"tracked":false,"synced":false,"conflicted":false,"targetChangeId":"change-1"}',
                '{"name":"feature","remote":"origin","tracked":true,"synced":false,"conflicted":false,"targetChangeId":"remote-change"}',
              ].join("\n"),
            ),
          );
        case "JjCore.resolveNearestBookmark":
          return Effect.succeed(result('{"name":"feature"}\n'));
        case "JjCore.status.nearestBookmarkDistance":
          return Effect.succeed(result("change-1\n"));
        case "JjCore.status.ahead":
          return Effect.succeed(result("ahead-1\nahead-2\n"));
        case "JjCore.status.behind":
          return Effect.succeed(result("behind-1\n"));
        default:
          return Effect.die(new Error(`Unexpected operation ${input.operation}`));
      }
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const status = await Effect.runPromise(core.status(repositoryRoot));

    expect(status).toMatchObject({
      currentBookmark: "feature",
      nearestBookmarkDistance: {
        bookmark: "feature",
        nonEmptyChangeCount: 1,
      },
      upstreamBookmark: "feature@origin",
      aheadCount: 2,
      behindCount: 1,
    });
    const aheadArgs = calls.find((call) => call.operation === "JjCore.status.ahead")?.args;
    const behindArgs = calls.find((call) => call.operation === "JjCore.status.behind")?.args;
    expect(aheadArgs?.join(" ")).toContain(
      'remote_bookmarks(exact:"feature", exact:"origin")..bookmarks(exact:"feature")',
    );
    expect(behindArgs?.join(" ")).toContain(
      'bookmarks(exact:"feature")..remote_bookmarks(exact:"feature", exact:"origin")',
    );
  });

  it("compares and advances a local bookmark against a differently named remote bookmark", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (input.operation === "JjCore.compareBookmarkToRemote.ahead") {
        return Effect.succeed(result("ahead-1\n"));
      }
      if (input.operation === "JjCore.compareBookmarkToRemote.behind") {
        return Effect.succeed(result("behind-1\nbehind-2\n"));
      }
      if (
        input.operation === "JjCore.detectRepository.root" ||
        input.operation === "JjCore.detectRepository.gitRoot"
      ) {
        return Effect.succeed(result(`${repositoryRoot}\n`));
      }
      return Effect.succeed(result());
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const comparison = await Effect.runPromise(
      core.compareBookmarkToRemote(repositoryRoot, "synara/pr-42/main", "alice", "main"),
    );
    await Effect.runPromise(
      core.advanceBookmark(repositoryRoot, "synara/pr-42/main", "alice", "main"),
    );

    expect(comparison).toEqual({ aheadCount: 1, behindCount: 2 });
    expect(
      calls
        .find((call) => call.operation === "JjCore.compareBookmarkToRemote.ahead")
        ?.args.join(" "),
    ).toContain(
      'remote_bookmarks(exact:"main", exact:"alice")..bookmarks(exact:"synara/pr-42/main")',
    );
    expect(calls.find((call) => call.operation === "JjCore.advanceBookmark.move")?.args).toEqual([
      "bookmark",
      "set",
      "synara/pr-42/main",
      "--revision",
      "main@alice",
    ]);
    expect(
      calls.findIndex((call) => call.operation === "JjCore.advanceBookmark.rebase"),
    ).toBeLessThan(calls.findIndex((call) => call.operation === "JjCore.advanceBookmark.move"));
  });

  it("reports a non-repository without attempting dependent probes", async () => {
    const executeOverride: JjCoreShape["execute"] = () =>
      Effect.succeed(result("", "not a repo", 1));
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    await expect(Effect.runPromise(core.detectRepository("/not-a-repo"))).resolves.toBeNull();
  });

  it("initializes a Git-backed JJ repository through the native command", async () => {
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (input.operation === "JjCore.detectRepository.root") {
        return Effect.succeed(result("", "not a repo", 1));
      }
      if (input.operation === "JjCore.initRepository") {
        return Effect.succeed(result());
      }
      return Effect.die(new Error(`Unexpected operation ${input.operation}`));
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    await Effect.runPromise(core.initRepository("/new-repo"));

    expect(calls.find((call) => call.operation === "JjCore.initRepository")?.args).toEqual([
      "git",
      "init",
    ]);
  });

  it("starts a described change at a bookmark and returns its identity", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (input.operation === "JjCore.detectRepository.root") {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.detectRepository.gitRoot") {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.startNewChange") {
        return Effect.succeed(result());
      }
      if (input.operation === "JjCore.readRevisionIdentity") {
        return Effect.succeed(
          result(
            '{"changeId":"change-next","commitId":"commit-next","description":"wip: Synara on feature"}\n',
          ),
        );
      }
      return Effect.die(new Error(`Unexpected operation ${input.operation}`));
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const revision = await Effect.runPromise(
      core.startNewChange(repositoryRoot, "feature", "wip: Synara on feature"),
    );

    expect(revision).toEqual({
      changeId: "change-next",
      commitId: "commit-next",
      description: "wip: Synara on feature",
    });
    expect(calls.find((call) => call.operation === "JjCore.startNewChange")?.args).toEqual([
      "new",
      "--message",
      "wip: Synara on feature",
      "feature",
    ]);
  });

  it("uses native JJ commands for commit, bookmark, fetch, pull, and push", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (
        input.operation === "JjCore.detectRepository.root" ||
        input.operation === "JjCore.detectRepository.gitRoot"
      ) {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.readRevisionIdentity") {
        return Effect.succeed(
          result(
            '{"changeId":"change-committed","commitId":"commit-committed","description":"feat: native jj"}\n',
          ),
        );
      }
      if (input.operation === "JjCore.listGitRemotes") {
        return Effect.succeed(result("upstream https://github.com/acme/repo.git\n"));
      }
      return Effect.succeed(result());
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const committed = await Effect.runPromise(
      core.commitWorkingCopy(repositoryRoot, "feat: native jj", ["src/a.ts"]),
    );
    await Effect.runPromise(core.setBookmark(repositoryRoot, "feature", committed.commitId));
    await Effect.runPromise(core.trackBookmark(repositoryRoot, "feature@upstream"));
    const remotes = await Effect.runPromise(core.listGitRemotes(repositoryRoot));
    await Effect.runPromise(core.deleteBookmark(repositoryRoot, "temporary"));
    await Effect.runPromise(core.importGit(repositoryRoot));
    await Effect.runPromise(core.fetchGit(repositoryRoot, "upstream"));
    await Effect.runPromise(core.advanceBookmark(repositoryRoot, "feature", "upstream"));
    await Effect.runPromise(core.pushBookmark(repositoryRoot, "feature", "upstream"));

    expect(committed.commitId).toBe("commit-committed");
    expect(remotes).toEqual([
      {
        name: "upstream",
        url: "https://github.com/acme/repo.git",
      },
    ]);
    expect(calls.find((call) => call.operation === "JjCore.commitWorkingCopy")?.args).toEqual([
      "commit",
      "--message",
      "feat: native jj",
      "--",
      "src/a.ts",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.setBookmark")?.args).toEqual([
      "bookmark",
      "set",
      "feature",
      "--revision",
      "commit-committed",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.trackBookmark")?.args).toEqual([
      "bookmark",
      "track",
      "feature@upstream",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.deleteBookmark")?.args).toEqual([
      "bookmark",
      "delete",
      "temporary",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.fetchGit")?.args).toEqual([
      "git",
      "fetch",
      "--remote",
      "upstream",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.importGit")?.args).toEqual([
      "git",
      "import",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.advanceBookmark.move")?.args).toEqual([
      "bookmark",
      "set",
      "feature",
      "--revision",
      "feature@upstream",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.advanceBookmark.rebase")?.args).toEqual([
      "rebase",
      "-s",
      "@",
      "-d",
      "feature@upstream",
    ]);
    expect(calls.find((call) => call.operation === "JjCore.pushBookmark")?.args).toEqual([
      "git",
      "push",
      "--remote",
      "upstream",
      "--bookmark",
      "exact:feature",
    ]);
  });

  it("creates the next available local bookmark name", async () => {
    const repositoryRoot = nodePath.resolve(import.meta.dirname, "../../../../..");
    const calls: ExecuteJjInput[] = [];
    const executeOverride: JjCoreShape["execute"] = (input) => {
      calls.push(input);
      if (
        input.operation === "JjCore.detectRepository.root" ||
        input.operation === "JjCore.detectRepository.gitRoot"
      ) {
        return Effect.succeed(result(repositoryRoot));
      }
      if (input.operation === "JjCore.readRevisionIdentity") {
        return Effect.succeed(
          result('{"changeId":"working-change","commitId":"working-commit","description":""}\n'),
        );
      }
      if (input.operation === "JjCore.listBookmarks") {
        return Effect.succeed(
          result(
            [
              '{"name":"synara/topic","remote":null,"tracked":false,"synced":false,"conflicted":false,"targetChangeId":"topic-change"}',
              '{"name":"synara/topic-2","remote":null,"tracked":false,"synced":false,"conflicted":false,"targetChangeId":"topic-two-change"}',
              '{"name":"synara/topic-3","remote":"origin","tracked":false,"synced":false,"conflicted":false,"targetChangeId":"remote-change"}',
            ].join("\n"),
          ),
        );
      }
      return Effect.succeed(result());
    };
    const core = await Effect.runPromise(makeJjCore({ executeOverride }));

    const bookmark = await Effect.runPromise(
      core.createAvailableBookmark(repositoryRoot, "synara/topic", "@-"),
    );

    expect(bookmark).toBe("synara/topic-3");
    expect(calls.find((call) => call.operation === "JjCore.createAvailableBookmark")?.args).toEqual(
      ["bookmark", "create", "--revision", "@-", "synara/topic-3"],
    );
  });
});
