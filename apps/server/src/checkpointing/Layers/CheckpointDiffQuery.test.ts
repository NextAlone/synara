import {
  CheckpointRef,
  ProjectId,
  ThreadId,
  TurnId,
  type ProjectKind,
  type VcsBackend,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { fakeProjectionSnapshotQuery } from "../../orchestration/testing/fakeProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn, checkpointRefForThreadTurnStart } from "../Utils.ts";
import { CheckpointInvariantError } from "../Errors.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly projectKind?: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode?: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly workingDirectory?: string | null;
  readonly vcsBackend?: VcsBackend | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status?: "ready" | "missing" | "error";
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    projectKind: input.projectKind ?? "project",
    workspaceRoot: input.workspaceRoot,
    envMode: input.envMode ?? "local",
    worktreePath: input.worktreePath,
    workingDirectory: input.workingDirectory ?? null,
    vcsBackend: input.vcsBackend === undefined ? "git" : input.vcsBackend,
    checkpoints: [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: input.status ?? "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeFullThreadDiffContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly projectKind?: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode?: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly workingDirectory?: string | null;
  readonly vcsBackend?: VcsBackend | null;
  readonly latestCheckpointTurnCount: number;
  readonly baselineCheckpointRef?: CheckpointRef | null;
  readonly baselineCheckpointStatus?: "ready" | "missing" | "error" | null;
  readonly toCheckpointRef: CheckpointRef | null;
  readonly toCheckpointStatus?: "ready" | "missing" | "error" | null;
}): ProjectionFullThreadDiffContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    projectKind: input.projectKind ?? "project",
    workspaceRoot: input.workspaceRoot,
    envMode: input.envMode ?? "local",
    worktreePath: input.worktreePath,
    workingDirectory: input.workingDirectory ?? null,
    vcsBackend: input.vcsBackend === undefined ? "git" : input.vcsBackend,
    latestCheckpointTurnCount: input.latestCheckpointTurnCount,
    baselineCheckpointRef: input.baselineCheckpointRef ?? input.toCheckpointRef,
    baselineCheckpointStatus: input.baselineCheckpointStatus ?? "ready",
    toCheckpointRef: input.toCheckpointRef,
    toCheckpointStatus: input.toCheckpointStatus ?? "ready",
  };
}

describe("CheckpointDiffQueryLive", () => {
  it("prefers exact turn-start checkpoints for single-turn diffs", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );
    const hasCheckpointRefCalls: Array<CheckpointRef> = [];
    let failDiffAfterVerification = false;
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) => {
        diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace });
        return failDiffAfterVerification
          ? Effect.fail(
              new CheckpointInvariantError({
                operation: "test.diff",
                detail: "Checkpoint bookmark is unavailable for diff operation.",
              }),
            )
          : Effect.succeed("diff patch");
      },
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurnStart(threadId, TurnId.makeUnsafe("turn-1")).replace(
        "refs/synara/",
        "refs/historical/",
      ),
    );
    expect(hasCheckpointRefCalls).toEqual([toCheckpointRef, expectedFromRef]);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      status: "ready",
      diff: "diff patch",
    });

    failDiffAfterVerification = true;
    const unavailable = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(unavailable).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      status: "unavailable",
      code: "CHECKPOINT_BACKEND_UNAVAILABLE",
      message: "The checkpoint backend could not produce this diff.",
    });

    const empty = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 1,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(empty).toEqual({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 1,
      status: "ready",
      diff: "",
    });
  });

  it("uses the narrow full-thread diff context without loading checkpoint summaries", async () => {
    const projectId = ProjectId.makeUnsafe("project-full-diff");
    const threadId = ThreadId.makeUnsafe("thread-full-diff");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    const historicalBaselineRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const fullThreadDiffContext = makeFullThreadDiffContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      latestCheckpointTurnCount: 2,
      baselineCheckpointRef: historicalBaselineRef,
      toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace });
          return "full diff patch";
        }),
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getFullThreadDiffContext: () => Effect.succeed(Option.some(fullThreadDiffContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 2,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.makeUnsafe(
          historicalBaselineRef.replace(/\/turn\/1$/, "/turn/0"),
        ),
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      status: "ready",
      diff: "full diff patch",
    });
  });

  it("returns an explicit partial range when an old conversation lost its initial baseline", async () => {
    const projectId = ProjectId.makeUnsafe("project-partial-diff");
    const threadId = ThreadId.makeUnsafe("thread-partial-diff");
    const checkpoint1 = checkpointRefForThreadTurn(threadId, 1);
    const checkpoint2 = checkpointRefForThreadTurn(threadId, 2);
    const checkpoint3 = checkpointRefForThreadTurn(threadId, 3);
    const fullThreadDiffContext = makeFullThreadDiffContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      latestCheckpointTurnCount: 3,
      baselineCheckpointRef: checkpoint1,
      toCheckpointRef: checkpoint3,
    });
    const checkpointContext: ProjectionThreadCheckpointContext = {
      threadId,
      projectId,
      projectKind: "project",
      workspaceRoot: "/tmp/workspace",
      envMode: "local",
      worktreePath: null,
      workingDirectory: null,
      vcsBackend: "git",
      checkpoints: [
        {
          turnId: TurnId.makeUnsafe("turn-1"),
          checkpointTurnCount: 1,
          checkpointRef: checkpoint1,
          status: "missing",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:01.000Z",
        },
        {
          turnId: TurnId.makeUnsafe("turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: checkpoint2,
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:02.000Z",
        },
        {
          turnId: TurnId.makeUnsafe("turn-3"),
          checkpointTurnCount: 3,
          checkpointRef: checkpoint3,
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-01-01T00:00:03.000Z",
        },
      ],
    };
    const diffCheckpoints = vi.fn<CheckpointStoreShape["diffCheckpoints"]>(() =>
      Effect.succeed("partial diff patch"),
    );
    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.succeed(checkpointRef === checkpoint1 || checkpointRef === checkpoint3),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints,
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };
    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCommandReadModel: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          listStaleInFlightThreadIds: () => Effect.die("unused"),
          listManagedWorktreeThreads: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getSpaceShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeed(Option.some(checkpointContext)),
          listGeneratedImageActivitiesByTurn: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.succeed(Option.some(fullThreadDiffContext)),
          getThreadShellById: () => Effect.die("unused"),
          findSyntheticSubagentParentThread: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailForExportById: () => Effect.die("unused"),
          getThreadDetailSnapshotById: () => Effect.die("unused"),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 3,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpoints).toHaveBeenCalledWith(
      expect.objectContaining({
        fromCheckpointRef: checkpoint1,
        toCheckpointRef: checkpoint3,
      }),
    );
    expect(result).toEqual({
      threadId,
      fromTurnCount: 1,
      toTurnCount: 3,
      status: "ready",
      diff: "partial diff patch",
    });
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });

  it("fails when a worktree-mode thread has no materialized worktree path", async () => {
    const projectId = ProjectId.makeUnsafe("project-worktree");
    const threadId = ThreadId.makeUnsafe("thread-worktree");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/project-root",
      envMode: "worktree",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Workspace path missing");
  });

  it("fails for a chat-kind project with no materialized worktree, since chat containers have no real cwd", async () => {
    const projectId = ProjectId.makeUnsafe("project-chat");
    const threadId = ThreadId.makeUnsafe("thread-chat");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      projectKind: "chat",
      workspaceRoot: "/tmp/chat-root",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Workspace path missing");
  });

  it("finds an unbound Studio checkpoint in its actual JJ reference folder", async () => {
    const projectId = ProjectId.makeUnsafe("project-studio");
    const threadId = ThreadId.makeUnsafe("thread-studio");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{
      readonly cwd: string;
      readonly backend: VcsBackend;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      projectKind: "studio",
      workspaceRoot: "/tmp/studio-root",
      envMode: "local",
      worktreePath: null,
      workingDirectory: "/tmp/studio-reference",
      vcsBackend: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: ({ backend }) => Effect.succeed(backend === "jj"),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ cwd, backend }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ cwd, backend });
          return "diff patch";
        }),
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ cwd: "/tmp/studio-reference", backend: "jj" }]);
    expect(result).toMatchObject({ status: "ready", diff: "diff patch" });
  });

  it("reports pending while the selected checkpoint is still missing", async () => {
    const projectId = ProjectId.makeUnsafe("project-missing");
    const threadId = ThreadId.makeUnsafe("thread-missing-checkpoint");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
      status: "missing",
    });

    const diffCheckpoints = vi.fn<CheckpointStoreShape["diffCheckpoints"]>(() =>
      Effect.succeed("diff patch"),
    );
    const checkpointStore: CheckpointStoreShape = {
      isRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints,
      diffCheckpointToWorkingCopy: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      status: "pending",
      retryAfterMs: 500,
    });
    expect(diffCheckpoints).not.toHaveBeenCalled();
  });
});
