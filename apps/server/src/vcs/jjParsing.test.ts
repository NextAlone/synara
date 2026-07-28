import { describe, expect, it } from "vitest";

import {
  findJjWorkspaceRegistration,
  parseJjBookmarkNames,
  parseJjBookmarks,
  parseJjFileChanges,
  parseJjGitRemotes,
  parseJjRevisionIdentity,
  parseJjWorkspaces,
} from "./jjParsing.ts";

describe("JJ machine output parsing", () => {
  it("decodes exactly one revision identity", () => {
    expect(
      parseJjRevisionIdentity(
        '{"changeId":"change-1","commitId":"commit-1","description":"fix: \\\\t-safe"}\n',
      ),
    ).toEqual({
      changeId: "change-1",
      commitId: "commit-1",
      description: "fix: \\t-safe",
    });
    expect(() => parseJjRevisionIdentity("")).toThrow("Expected one JJ revision identity");
  });

  it("aggregates local and remote bookmark rows without conflating their targets", () => {
    const bookmarks = parseJjBookmarks(
      [
        '{"name":"feature","remote":"origin","tracked":true,"synced":false,"conflicted":false,"targetChangeId":"remote-change"}',
        '{"name":"feature","remote":null,"tracked":false,"synced":false,"conflicted":false,"targetChangeId":"local-change"}',
        '{"name":"feature","remote":"backup","tracked":false,"synced":true,"conflicted":true,"targetChangeId":"backup-change"}',
        '{"name":"remote-only","remote":"origin","tracked":false,"synced":false,"conflicted":false,"targetChangeId":"remote-only-change"}',
      ].join("\n"),
      "local-change",
    );

    expect(bookmarks).toEqual([
      {
        name: "feature",
        targetChangeId: "local-change",
        isLocal: true,
        current: true,
        conflicted: true,
        remotes: [
          {
            name: "backup",
            targetChangeId: "backup-change",
            tracked: false,
            synced: true,
          },
          {
            name: "origin",
            targetChangeId: "remote-change",
            tracked: true,
            synced: false,
          },
        ],
      },
      {
        name: "remote-only",
        targetChangeId: "remote-only-change",
        isLocal: false,
        current: false,
        conflicted: false,
        remotes: [
          {
            name: "origin",
            targetChangeId: "remote-only-change",
            tracked: false,
            synced: false,
          },
        ],
      },
    ]);
  });

  it("deduplicates and sorts bookmark-name rows", () => {
    expect(
      parseJjBookmarkNames(
        ['{"name":"trunk"}', '{"name":"feature"}', '{"name":"trunk"}'].join("\n"),
      ),
    ).toEqual(["feature", "trunk"]);
  });

  it("keeps source and target paths for removes and renames", () => {
    expect(
      parseJjFileChanges(
        [
          '{"status":"removed","sourcePath":"old.txt","targetPath":"old.txt","conflicted":false}',
          '{"status":"renamed","sourcePath":"before.ts","targetPath":"after.ts","conflicted":true}',
        ].join("\n"),
      ),
    ).toEqual([
      {
        status: "removed",
        path: "old.txt",
        sourcePath: "old.txt",
        targetPath: "old.txt",
        conflicted: false,
      },
      {
        status: "renamed",
        path: "after.ts",
        sourcePath: "before.ts",
        targetPath: "after.ts",
        conflicted: true,
      },
    ]);
  });

  it("distinguishes present, stale, and absent workspace registrations", () => {
    const workspaces = parseJjWorkspaces(
      ['"default"', '"/repo"', '"gone"', "<Error: Workspace has no recorded path: gone>", ""].join(
        "\0",
      ),
    );

    expect(findJjWorkspaceRegistration(workspaces, "default")).toEqual({
      kind: "present",
      root: "/repo",
    });
    expect(findJjWorkspaceRegistration(workspaces, "gone")).toEqual({ kind: "stale" });
    expect(findJjWorkspaceRegistration(workspaces, "missing")).toEqual({ kind: "absent" });
  });

  it("preserves JSON escaping inside NUL-framed workspace fields", () => {
    expect(
      parseJjWorkspaces(
        [JSON.stringify('quoted"workspace'), JSON.stringify("/repo/line\nbreak"), ""].join("\0"),
      ),
    ).toEqual([
      {
        name: 'quoted"workspace',
        registration: { kind: "present", root: "/repo/line\nbreak" },
      },
    ]);
  });

  it("rejects malformed workspace framing and non-sentinel root fields", () => {
    expect(() => parseJjWorkspaces('"default"\0"/repo"')).toThrow("NUL-terminated");
    expect(() => parseJjWorkspaces('"default"\0not-json\0')).toThrow();
  });

  it("parses and sorts Git remotes", () => {
    expect(
      parseJjGitRemotes(
        "upstream https://github.com/acme/upstream.git\norigin git@github.com:acme/repo.git\n",
      ),
    ).toEqual([
      { name: "origin", url: "git@github.com:acme/repo.git" },
      {
        name: "upstream",
        url: "https://github.com/acme/upstream.git",
      },
    ]);
  });

  it("rejects malformed JSONL rows at the command boundary", () => {
    expect(() =>
      parseJjFileChanges(
        '{"status":"unknown","sourcePath":"a","targetPath":"b","conflicted":false}\n',
      ),
    ).toThrow();
  });
});
