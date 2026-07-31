import { describe, expect, it } from "vitest";

import type { MessageId, ProjectId, ThreadId } from "@synara/contracts";

import type { AppState } from "./store";
import {
  createAllThreadsSelector,
  createAllThreadsMessagelessSelector,
  createComposerThreadMentionSourcesSelector,
  createSidebarTreeThreadsSelector,
  createThreadExistsSelector,
  createThreadProjectIdSelector,
  createThreadShellsSelector,
  createThreadWorkspaceMetadataSelector,
} from "./storeSelectors";
import type { SidebarThreadSummary, ThreadShell } from "./types";

const threadIdA = "thread-a" as ThreadId;
const threadIdB = "thread-b" as ThreadId;
const messageId = "message-1" as MessageId;
const projectId = "project-1" as ProjectId;

const shellA = { id: threadIdA, projectId, title: "A" } as ThreadShell;
const shellB = { id: threadIdB, projectId, title: "B" } as ThreadShell;
const summaryA = {
  id: threadIdA,
  projectId,
  title: "A",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  latestUserMessageAt: null,
} as SidebarThreadSummary;

function makeSummary(
  id: ThreadId,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    ...summaryA,
    id,
    title: id,
    ...overrides,
  };
}

interface TestStateSlices {
  threadIds?: readonly ThreadId[];
  threadShellById?: Readonly<Record<string, ThreadShell>>;
  sidebarThreadSummaryById?: Readonly<Record<string, SidebarThreadSummary>>;
  messageIdsByThreadId?: Readonly<Record<string, readonly MessageId[]>>;
}

function makeState(slices: TestStateSlices): AppState {
  return {
    threadIds: slices.threadIds ?? [],
    threadShellById: slices.threadShellById ?? {},
    sidebarThreadSummaryById: slices.sidebarThreadSummaryById ?? {},
    messageIdsByThreadId: slices.messageIdsByThreadId ?? {},
  } as unknown as AppState;
}

describe("createThreadShellsSelector", () => {
  it("returns shells in threadIds order", () => {
    const selectShells = createThreadShellsSelector();
    const state = makeState({
      threadIds: [threadIdB, threadIdA],
      threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
    });

    expect(selectShells(state).map((shell) => shell.id)).toEqual([threadIdB, threadIdA]);
  });

  it("stays reference-stable when unrelated state changes (e.g. streaming messages)", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];
    const threadShellById = { [threadIdA]: shellA };

    const before = selectShells(makeState({ threadIds, threadShellById }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
  });

  it("returns a new array when shells change", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];

    const before = selectShells(makeState({ threadIds, threadShellById: { [threadIdA]: shellA } }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: { ...shellA, title: "renamed" } },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.title).toBe("renamed");
  });
});

describe("createComposerThreadMentionSourcesSelector", () => {
  it("does not rescan summaries when only streaming detail changes", () => {
    const selectSources = createComposerThreadMentionSourcesSelector();
    const threadIds = [threadIdA];
    let summaryReads = 0;
    const summaryById = new Proxy(
      { [threadIdA]: summaryA },
      {
        get(target, property, receiver) {
          summaryReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const before = selectSources(makeState({ threadIds, sidebarThreadSummaryById: summaryById }));
    const readsAfterFirstSelection = summaryReads;
    const after = selectSources(
      makeState({
        threadIds,
        sidebarThreadSummaryById: summaryById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
    expect(summaryReads).toBe(readsAfterFirstSelection);
  });
});

describe("createSidebarTreeThreadsSelector", () => {
  it("hides unarchived descendants of an archived thread", () => {
    const parentId = "thread-parent" as ThreadId;
    const childId = "thread-child" as ThreadId;
    const grandchildId = "thread-grandchild" as ThreadId;
    const visibleRootId = "thread-visible-root" as ThreadId;
    const threadIds = [parentId, childId, grandchildId, visibleRootId];
    const selectTreeThreads = createSidebarTreeThreadsSelector();

    const treeThreads = selectTreeThreads(
      makeState({
        threadIds,
        sidebarThreadSummaryById: {
          [parentId]: makeSummary(parentId, {
            archivedAt: "2026-07-31T03:55:20.188Z",
          }),
          [childId]: makeSummary(childId, { parentThreadId: parentId }),
          [grandchildId]: makeSummary(grandchildId, { parentThreadId: childId }),
          [visibleRootId]: makeSummary(visibleRootId),
        },
      }),
    );

    expect(treeThreads.map((thread) => thread.id)).toEqual([visibleRootId]);
  });

  it("restores an archived thread and its descendants together", () => {
    const parentId = "thread-parent" as ThreadId;
    const childId = "thread-child" as ThreadId;
    const threadIds = [parentId, childId];
    const selectTreeThreads = createSidebarTreeThreadsSelector();

    expect(
      selectTreeThreads(
        makeState({
          threadIds,
          sidebarThreadSummaryById: {
            [parentId]: makeSummary(parentId, {
              archivedAt: "2026-07-31T03:55:20.188Z",
            }),
            [childId]: makeSummary(childId, { parentThreadId: parentId }),
          },
        }),
      ),
    ).toEqual([]);

    expect(
      selectTreeThreads(
        makeState({
          threadIds,
          sidebarThreadSummaryById: {
            [parentId]: makeSummary(parentId, { archivedAt: null }),
            [childId]: makeSummary(childId, { parentThreadId: parentId }),
          },
        }),
      ).map((thread) => thread.id),
    ).toEqual([parentId, childId]);
  });

  it("keeps a child visible when its parent is genuinely missing", () => {
    const childId = "thread-child" as ThreadId;
    const missingParentId = "thread-missing-parent" as ThreadId;
    const selectTreeThreads = createSidebarTreeThreadsSelector();

    expect(
      selectTreeThreads(
        makeState({
          threadIds: [childId],
          sidebarThreadSummaryById: {
            [childId]: makeSummary(childId, { parentThreadId: missingParentId }),
          },
        }),
      ).map((thread) => thread.id),
    ).toEqual([childId]);
  });
});

describe("createAllThreadsSelector", () => {
  it("preserves the untouched thread identity when another thread shell changes", () => {
    const selectThreads = createAllThreadsSelector();
    const threadIds = [threadIdA, threadIdB];
    const before = selectThreads(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
      }),
    );
    const after = selectThreads(
      makeState({
        threadIds,
        threadShellById: {
          [threadIdA]: { ...shellA, title: "renamed" },
          [threadIdB]: shellB,
        },
      }),
    );

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe("createAllThreadsMessagelessSelector", () => {
  it("is vacuously true with no threads", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    expect(selectMessageless(makeState({}))).toBe(true);
  });

  it("is true when every thread has no message ids", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdA]: [] },
    });
    expect(selectMessageless(state)).toBe(true);
  });

  it("is false once any thread has a message", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdB]: [messageId] },
    });
    expect(selectMessageless(state)).toBe(false);
  });
});

describe("thread shell route selectors", () => {
  it("resolve existence and project id without reading detail slices", () => {
    const state = makeState({
      threadIds: [threadIdA],
      threadShellById: { [threadIdA]: shellA },
    });
    Object.defineProperty(state, "messageIdsByThreadId", {
      get() {
        throw new Error("detail messages should not be read");
      },
    });

    expect(createThreadExistsSelector(threadIdA)(state)).toBe(true);
    expect(createThreadProjectIdSelector(threadIdA)(state)).toBe(projectId);
  });

  it("keeps workspace metadata stable while streaming messages change", () => {
    const selectWorkspaceMetadata = createThreadWorkspaceMetadataSelector(threadIdA);
    const threadIds = [threadIdA];
    const threadShellById = {
      [threadIdA]: {
        ...shellA,
        envMode: "worktree" as const,
        worktreePath: "/repo/.worktrees/feature",
      },
    };

    const before = selectWorkspaceMetadata(makeState({ threadIds, threadShellById }));
    const after = selectWorkspaceMetadata(
      makeState({
        threadIds,
        threadShellById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
    expect(after).toEqual({
      envMode: "worktree",
      worktreePath: "/repo/.worktrees/feature",
      workingDirectory: null,
    });
  });

  it("updates workspace metadata when a Studio working directory changes", () => {
    const selectWorkspaceMetadata = createThreadWorkspaceMetadataSelector(threadIdA);
    const before = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: {
          [threadIdA]: {
            ...shellA,
            envMode: "local",
            workingDirectory: "/repo/one",
          },
        },
      }),
    );
    const after = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: {
          [threadIdA]: {
            ...shellA,
            envMode: "local",
            workingDirectory: "/repo/two",
          },
        },
      }),
    );

    expect(after).not.toBe(before);
    expect(after).toEqual({
      envMode: "local",
      worktreePath: null,
      workingDirectory: "/repo/two",
    });
  });
});
