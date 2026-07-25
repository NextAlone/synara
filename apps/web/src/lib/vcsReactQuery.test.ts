import { ProjectId, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeVcsQueryTarget, vcsQueryKeys } from "./vcsReactQuery";

const projectId = ProjectId.makeUnsafe("project-vcs-query-target");
const threadId = ThreadId.makeUnsafe("thread-vcs-query-target");

describe("makeVcsQueryTarget", () => {
  it("keeps an ordinary unbound project disabled", () => {
    expect(
      makeVcsQueryTarget({ id: projectId, vcs: { epoch: 0, binding: null } }, threadId, "git"),
    ).toEqual({
      projectId,
      threadId,
      epoch: 0,
      backend: null,
    });
  });

  it("enables a persisted Studio reference folder without inventing a binding", () => {
    expect(
      makeVcsQueryTarget(
        {
          id: projectId,
          kind: "studio",
          vcs: { epoch: 0, binding: null },
        },
        threadId,
        "jj",
        { threadWorkingDirectory: "/repo/reference" },
      ),
    ).toEqual({
      projectId,
      threadId,
      epoch: 0,
      backend: "jj",
    });
  });

  it("does not let an ordinary working directory bypass a mismatched binding", () => {
    expect(
      makeVcsQueryTarget(
        {
          id: projectId,
          vcs: {
            epoch: 4,
            binding: {
              backend: "git",
              repoRoot: "/repo",
              projectRelativePath: ".",
            },
          },
        },
        threadId,
        "jj",
        { threadWorkingDirectory: "/repo/reference" },
      ),
    ).toEqual({
      projectId,
      threadId,
      epoch: 4,
      backend: null,
    });
  });

  it("keeps Studio disabled without both a persisted thread and reference folder", () => {
    const studioProject = {
      id: projectId,
      kind: "studio" as const,
      vcs: { epoch: 0, binding: null },
    };

    expect(
      makeVcsQueryTarget(studioProject, null, "git", {
        threadWorkingDirectory: "/repo/reference",
      }).backend,
    ).toBeNull();
    expect(
      makeVcsQueryTarget(studioProject, threadId, "git", {
        threadWorkingDirectory: null,
      }).backend,
    ).toBeNull();
  });

  it("separates thread-scoped workspace inventories in the query cache", () => {
    const target = {
      projectId,
      epoch: 2,
      backend: "jj" as const,
    };

    expect(
      vcsQueryKeys.workspacesFor({
        ...target,
        threadId: ThreadId.makeUnsafe("thread-a"),
      }),
    ).not.toEqual(
      vcsQueryKeys.workspacesFor({
        ...target,
        threadId: ThreadId.makeUnsafe("thread-b"),
      }),
    );
  });
});
