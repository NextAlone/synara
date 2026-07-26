import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type CheckpointDiffUnavailableCode,
  type CheckpointRef,
  type VcsBackend,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError } from "../Errors.ts";
import {
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnInManagedFamily,
  checkpointRefForThreadTurnStart,
  checkpointRefForThreadTurnStartInManagedFamily,
  resolveThreadWorkspaceCwd,
} from "../Utils.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "../Services/CheckpointDiffQuery.ts";

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(input: {
  readonly threadId: OrchestrationGetTurnDiffResultType["threadId"];
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly diff: string;
}): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    status: "ready",
    diff: input.diff,
  };
}

function buildPendingTurnDiffResult(input: {
  readonly threadId: OrchestrationGetTurnDiffResultType["threadId"];
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly retryAfterMs?: number;
}): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    status: "pending",
    retryAfterMs: input.retryAfterMs ?? 500,
  };
}

function buildUnavailableTurnDiffResult(input: {
  readonly threadId: OrchestrationGetTurnDiffResultType["threadId"];
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly code: CheckpointDiffUnavailableCode;
  readonly message: string;
}): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    status: "unavailable",
    code: input.code,
    message: input.message,
  };
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore;

  const resolveCheckpointBackend = Effect.fnUntraced(function* (input: {
    readonly cwd: string;
    readonly configuredBackend: VcsBackend | null;
    readonly checkpointRef: CheckpointRef;
  }) {
    if (input.configuredBackend) {
      return (yield* checkpointStore.isRepository({
        cwd: input.cwd,
        backend: input.configuredBackend,
      }))
        ? input.configuredBackend
        : null;
    }

    // Studio projects intentionally have no persisted project binding. Probe
    // the concrete checkpoint ref so reads follow the backend that captured
    // this turn instead of guessing from repository shape alone (a colocated
    // JJ repository is also a valid Git repository).
    for (const backend of ["git", "jj"] as const) {
      if (
        (yield* checkpointStore.isRepository({ cwd: input.cwd, backend })) &&
        (yield* checkpointStore.hasCheckpointRef({
          cwd: input.cwd,
          backend,
          checkpointRef: input.checkpointRef,
        }))
      ) {
        return backend;
      }
    }
    return null;
  });

  const resolveFullThreadBaseline = Effect.fnUntraced(function* (input: {
    readonly threadId: OrchestrationGetTurnDiffResultType["threadId"];
    readonly toTurnCount: number;
    readonly cwd: string;
    readonly backend: VcsBackend;
    readonly initialCheckpointRef: CheckpointRef | null;
    readonly initialCheckpointStatus: "ready" | "missing" | "error" | null;
  }) {
    const checkpointWorkspace = { cwd: input.cwd, backend: input.backend };
    if (input.initialCheckpointRef && input.initialCheckpointStatus === "ready") {
      const initialBaselineRef =
        checkpointRefForThreadTurnInManagedFamily(
          input.initialCheckpointRef,
          input.threadId,
          0,
        ) ?? checkpointRefForThreadTurn(input.threadId, 0);
      if (
        yield* checkpointStore.hasCheckpointRef({
          ...checkpointWorkspace,
          checkpointRef: initialBaselineRef,
        })
      ) {
        return { checkpointRef: initialBaselineRef, fromTurnCount: 0 };
      }
    }

    // Older conversations can predate durable turn-0 aliases. Recover the
    // broadest verifiable range from a retained turn-start snapshot, then from
    // a retained completed-turn snapshot. The returned fromTurnCount makes the
    // degraded range explicit to the client.
    const checkpointContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      input.threadId,
    );
    if (Option.isNone(checkpointContext)) {
      return null;
    }
    const candidates = checkpointContext.value.checkpoints
      .filter(
        (checkpoint) =>
          checkpoint.checkpointTurnCount <= input.toTurnCount &&
          !checkpoint.checkpointRef.startsWith("provider-diff:"),
      )
      .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount);

    for (const checkpoint of candidates) {
      if (checkpoint.status === "ready") {
        const turnStartCheckpointRef =
          checkpointRefForThreadTurnStartInManagedFamily(
            checkpoint.checkpointRef,
            input.threadId,
            checkpoint.turnId,
          ) ?? checkpointRefForThreadTurnStart(input.threadId, checkpoint.turnId);
        if (
          yield* checkpointStore.hasCheckpointRef({
            ...checkpointWorkspace,
            checkpointRef: turnStartCheckpointRef,
          })
        ) {
          return {
            checkpointRef: turnStartCheckpointRef,
            fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
          };
        }
      }

      if (checkpoint.checkpointTurnCount >= input.toTurnCount) {
        continue;
      }
      const completedTurnCheckpointExists = yield* checkpointStore.hasCheckpointRef({
        ...checkpointWorkspace,
        checkpointRef: checkpoint.checkpointRef,
      });
      if (completedTurnCheckpointExists) {
        return {
          checkpointRef: checkpoint.checkpointRef,
          fromTurnCount: checkpoint.checkpointTurnCount,
        };
      }
    }
    return null;
  });

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        });
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed turn diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery.getThreadCheckpointContext(
        input.threadId,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return buildPendingTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread: {
          projectId: threadContext.value.projectId,
          envMode: threadContext.value.envMode,
          worktreePath: threadContext.value.worktreePath,
          workingDirectory: threadContext.value.workingDirectory,
        },
        projects: [
          {
            id: threadContext.value.projectId,
            kind: threadContext.value.projectKind,
            workspaceRoot: threadContext.value.workspaceRoot,
          },
        ],
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing turn diff.`,
        });
      }
      const toCheckpoint = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      );
      if (!toCheckpoint) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} is unavailable.`,
        });
      }
      if (toCheckpoint.status === "missing") {
        return buildPendingTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
        });
      }
      if (toCheckpoint.status !== "ready") {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} was not captured.`,
        });
      }
      const backend = yield* resolveCheckpointBackend({
        cwd: workspaceCwd,
        configuredBackend: threadContext.value.vcsBackend,
        checkpointRef: toCheckpoint.checkpointRef,
      });
      if (!backend) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "CHECKPOINT_BACKEND_UNAVAILABLE",
          message: "The source control backend for this checkpoint is unavailable.",
        });
      }
      const checkpointWorkspace = { cwd: workspaceCwd, backend };
      if (
        !(yield* checkpointStore.hasCheckpointRef({
          ...checkpointWorkspace,
          checkpointRef: toCheckpoint.checkpointRef,
        }))
      ) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} is no longer available.`,
        });
      }

      const fromCheckpoint =
        input.fromTurnCount === 0
          ? null
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            );
      if (fromCheckpoint && fromCheckpoint.status !== "ready") {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "BASELINE_MISSING",
          message: `The baseline checkpoint for turn ${input.fromTurnCount} was not captured.`,
        });
      }

      const earliestManagedBaselineRef = threadContext.value.checkpoints
        .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
        .map((checkpoint) =>
          checkpointRefForThreadTurnInManagedFamily(checkpoint.checkpointRef, input.threadId, 0),
        )
        .find((checkpointRef) => checkpointRef !== null);
      let fromCheckpointRef =
        input.fromTurnCount === 0
          ? (earliestManagedBaselineRef ?? checkpointRefForThreadTurn(input.threadId, 0))
          : fromCheckpoint?.checkpointRef;
      if (!fromCheckpointRef) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "BASELINE_MISSING",
          message: `The baseline checkpoint for turn ${input.fromTurnCount} is unavailable.`,
        });
      }

      const toCheckpointRef = toCheckpoint.checkpointRef;
      let fromCheckpointExists = false;
      if (input.toTurnCount === input.fromTurnCount + 1) {
        const turnStartCheckpointRef =
          checkpointRefForThreadTurnStartInManagedFamily(
            toCheckpointRef,
            input.threadId,
            toCheckpoint.turnId,
          ) ?? checkpointRefForThreadTurnStart(input.threadId, toCheckpoint.turnId);
        const turnStartExists = yield* checkpointStore.hasCheckpointRef({
          ...checkpointWorkspace,
          checkpointRef: turnStartCheckpointRef,
        });
        if (turnStartExists) {
          fromCheckpointRef = turnStartCheckpointRef;
          fromCheckpointExists = true;
        }
      }
      if (
        !fromCheckpointExists &&
        !(yield* checkpointStore.hasCheckpointRef({
          ...checkpointWorkspace,
          checkpointRef: fromCheckpointRef,
        }))
      ) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "BASELINE_MISSING",
          message: `The baseline checkpoint for turn ${input.fromTurnCount} is no longer available.`,
        });
      }

      const diff = yield* checkpointStore
        .diffCheckpoints({
          ...checkpointWorkspace,
          fromCheckpointRef,
          toCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("checkpoint diff failed after refs were verified", {
              threadId: input.threadId,
              fromTurnCount: input.fromTurnCount,
              toTurnCount: input.toTurnCount,
              detail: error.message,
            }),
          ),
          Effect.option,
        );
      if (Option.isNone(diff)) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          code: "CHECKPOINT_BACKEND_UNAVAILABLE",
          message: "The checkpoint backend could not produce this diff.",
        });
      }

      const turnDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: diff.value,
      });
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed turn diff result does not satisfy contract schema.",
        });
      }

      return turnDiff;
    });

  const getFullThreadDiff: CheckpointDiffQueryShape["getFullThreadDiff"] = (
    input: OrchestrationGetFullThreadDiffInput,
  ) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getFullThreadDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.toTurnCount === 0) {
        const emptyDiff = buildTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
          diff: "",
        });
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Computed full thread diff result does not satisfy contract schema.",
          });
        }
        return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
      }

      const threadContext = yield* projectionSnapshotQuery.getFullThreadDiffContext(
        input.threadId,
        input.toTurnCount,
      );
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Thread '${input.threadId}' not found.`,
        });
      }

      if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
        return buildPendingTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
        });
      }

      const workspaceCwd = resolveThreadWorkspaceCwd({
        thread: {
          projectId: threadContext.value.projectId,
          envMode: threadContext.value.envMode,
          worktreePath: threadContext.value.worktreePath,
          workingDirectory: threadContext.value.workingDirectory,
        },
        projects: [
          {
            id: threadContext.value.projectId,
            kind: threadContext.value.projectKind,
            workspaceRoot: threadContext.value.workspaceRoot,
          },
        ],
      });
      if (!workspaceCwd) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Workspace path missing for thread '${input.threadId}' when computing full thread diff.`,
        });
      }
      if (
        !threadContext.value.toCheckpointRef ||
        threadContext.value.toCheckpointStatus === null
      ) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} was not captured.`,
        });
      }
      if (threadContext.value.toCheckpointStatus === "missing") {
        return buildPendingTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
        });
      }
      if (threadContext.value.toCheckpointStatus !== "ready") {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} was not captured.`,
        });
      }
      const backend = yield* resolveCheckpointBackend({
        cwd: workspaceCwd,
        configuredBackend: threadContext.value.vcsBackend,
        checkpointRef: threadContext.value.toCheckpointRef,
      });
      if (!backend) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "CHECKPOINT_BACKEND_UNAVAILABLE",
          message: "The source control backend for this checkpoint is unavailable.",
        });
      }
      const checkpointWorkspace = { cwd: workspaceCwd, backend };
      if (
        !(yield* checkpointStore.hasCheckpointRef({
          ...checkpointWorkspace,
          checkpointRef: threadContext.value.toCheckpointRef,
        }))
      ) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "END_SNAPSHOT_MISSING",
          message: `The checkpoint for turn ${input.toTurnCount} is no longer available.`,
        });
      }
      const baseline = yield* resolveFullThreadBaseline({
        threadId: input.threadId,
        toTurnCount: input.toTurnCount,
        cwd: workspaceCwd,
        backend,
        initialCheckpointRef: threadContext.value.baselineCheckpointRef,
        initialCheckpointStatus: threadContext.value.baselineCheckpointStatus,
      });
      if (!baseline) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "BASELINE_MISSING",
          message: "No usable checkpoint baseline remains for this conversation.",
        });
      }

      const diff = yield* checkpointStore
        .diffCheckpoints({
          ...checkpointWorkspace,
          fromCheckpointRef: baseline.checkpointRef,
          toCheckpointRef: threadContext.value.toCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace,
        })
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("full checkpoint diff failed after refs were verified", {
              threadId: input.threadId,
              fromTurnCount: baseline.fromTurnCount,
              toTurnCount: input.toTurnCount,
              detail: error.message,
            }),
          ),
          Effect.option,
        );
      if (Option.isNone(diff)) {
        return buildUnavailableTurnDiffResult({
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
          code: "CHECKPOINT_BACKEND_UNAVAILABLE",
          message: "The checkpoint backend could not produce this conversation diff.",
        });
      }

      const fullThreadDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: baseline.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff: diff.value,
      });
      if (!isTurnDiffResult(fullThreadDiff)) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: "Computed full thread diff result does not satisfy contract schema.",
        });
      }

      return fullThreadDiff satisfies OrchestrationGetFullThreadDiffResult;
    });

  return {
    getTurnDiff,
    getFullThreadDiff,
  } satisfies CheckpointDiffQueryShape;
});

export const CheckpointDiffQueryLive = Layer.effect(CheckpointDiffQuery, make);
