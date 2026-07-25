import { describe, expect, it } from "vitest";
import {
  formatIsolatedWorkspaceNoun,
  resolveDiffEnvironmentState,
  resolveForkThreadEnvironment,
  resolveIsolatedWorkspaceNoun,
  resolveThreadEnvironmentPresentation,
} from "./threadEnvironment";

describe("threadEnvironment", () => {
  it("keeps a worktree fork into local on the same worktree", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "local",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/worktree-branch",
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/feature-worktree-branch",
        },
      }),
    ).toEqual({
      target: "local",
      envMode: "worktree",
      branch: "feature/worktree-branch",
      worktreePath: "/repo/.worktrees/feature-worktree-branch",
      associatedWorktreePath: "/repo/.worktrees/feature-worktree-branch",
      associatedWorktreeBranch: "feature/worktree-branch",
      associatedWorktreeRef: "feature/worktree-branch",
    });
  });

  it("keeps a local fork into local on the root checkout", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "local",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/local-branch",
          envMode: "local",
          worktreePath: null,
        },
      }),
    ).toEqual({
      target: "local",
      envMode: "local",
      branch: "feature/local-branch",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: null,
      associatedWorktreeRef: null,
    });
  });

  it("plans a new worktree fork without reusing the source path", () => {
    expect(
      resolveForkThreadEnvironment({
        target: "worktree",
        activeRootBranch: "main",
        sourceThread: {
          branch: "feature/source-branch",
          envMode: "worktree",
          worktreePath: "/repo/.worktrees/source-branch",
        },
      }),
    ).toEqual({
      target: "worktree",
      envMode: "worktree",
      branch: "feature/source-branch",
      worktreePath: null,
      associatedWorktreePath: null,
      associatedWorktreeBranch: "feature/source-branch",
      associatedWorktreeRef: "feature/source-branch",
    });
  });

  it("marks diff state as pending when a worktree chat has no materialized path yet", () => {
    expect(
      resolveDiffEnvironmentState({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: null,
      }),
    ).toEqual({
      pending: true,
      cwd: null,
      disabledReason:
        "Diff and summary will be available once the worktree is ready for this chat.",
    });
  });

  it("uses workspace wording for pending JJ isolated environments", () => {
    expect(
      resolveDiffEnvironmentState({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: null,
        backend: "jj",
      }).disabledReason,
    ).toBe("Diff and summary will be available once the workspace is ready for this chat.");
  });

  it("labels JJ isolated environments as workspace, not worktree", () => {
    expect(resolveIsolatedWorkspaceNoun("jj")).toBe("workspace");
    expect(formatIsolatedWorkspaceNoun("jj")).toBe("Workspace");
    expect(
      resolveThreadEnvironmentPresentation({
        envMode: "worktree",
        worktreePath: null,
        backend: "jj",
      }),
    ).toMatchObject({
      shortLabel: "Workspace",
      worktreeOptionLabel: "Workspace",
      newIsolatedOptionLabel: "New workspace",
      handOffToIsolatedLabel: "Hand off to new workspace",
      worktreeBadgeLabel: "Workspace pending",
    });
    expect(
      resolveThreadEnvironmentPresentation({
        envMode: "worktree",
        worktreePath: "/repo/.worktrees/feature",
        backend: "git",
      }),
    ).toMatchObject({
      shortLabel: "Worktree",
      newIsolatedOptionLabel: "New worktree",
      worktreeBadgeLabel: "Worktree",
    });
  });

  it("resolves diff state to the worktree cwd once the path exists", () => {
    expect(
      resolveDiffEnvironmentState({
        projectCwd: "/repo",
        envMode: "worktree",
        worktreePath: "/repo/.worktrees/feature-x",
      }),
    ).toEqual({
      pending: false,
      cwd: "/repo/.worktrees/feature-x",
      disabledReason: null,
    });
  });

  it("uses a Studio reference folder for a local diff", () => {
    expect(
      resolveDiffEnvironmentState({
        projectCwd: "/studio",
        envMode: "local",
        worktreePath: null,
        workingDirectory: "/references/project",
      }),
    ).toEqual({
      pending: false,
      cwd: "/references/project",
      disabledReason: null,
    });
  });
});
