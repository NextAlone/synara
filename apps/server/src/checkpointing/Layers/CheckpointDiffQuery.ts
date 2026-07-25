import {
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type CheckpointRef,
  type VcsBackend,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { CheckpointInvariantError, CheckpointUnavailableError } from "../Errors.ts";
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
    diff: input.diff,
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

  const getTurnDiff: CheckpointDiffQueryShape["getTurnDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
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
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${maxTurnCount}.`,
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
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }
      if (toCheckpoint.status === "missing") {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint diff is not available yet for turn ${input.toTurnCount}.`,
        });
      }
      const backend = yield* resolveCheckpointBackend({
        cwd: workspaceCwd,
        configuredBackend: threadContext.value.vcsBackend,
        checkpointRef: toCheckpoint.checkpointRef,
      });
      if (!backend) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Checkpoint VCS backend is unavailable for thread '${input.threadId}'.`,
        });
      }
      const checkpointWorkspace = { cwd: workspaceCwd, backend };

      const fromCheckpoint =
        input.fromTurnCount === 0
          ? null
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            );
      if (fromCheckpoint?.status === "missing") {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint diff is not available yet for turn ${input.fromTurnCount}.`,
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
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.fromTurnCount}.`,
        });
      }

      const toCheckpointRef = toCheckpoint.checkpointRef;
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
        }
      }

      const diff = yield* checkpointStore.diffCheckpoints({
        ...checkpointWorkspace,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const turnDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: input.fromTurnCount,
        toTurnCount: input.toTurnCount,
        diff,
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
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Turn diff range exceeds current turn count: requested ${input.toTurnCount}, current ${threadContext.value.latestCheckpointTurnCount}.`,
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
      if (!threadContext.value.toCheckpointRef) {
        return yield* new CheckpointUnavailableError({
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          detail: `Checkpoint ref is unavailable for turn ${input.toTurnCount}.`,
        });
      }
      const backend = yield* resolveCheckpointBackend({
        cwd: workspaceCwd,
        configuredBackend: threadContext.value.vcsBackend,
        checkpointRef: threadContext.value.toCheckpointRef,
      });
      if (!backend) {
        return yield* new CheckpointInvariantError({
          operation,
          detail: `Checkpoint VCS backend is unavailable for thread '${input.threadId}'.`,
        });
      }
      const checkpointWorkspace = { cwd: workspaceCwd, backend };

      const diff = yield* checkpointStore.diffCheckpoints({
        ...checkpointWorkspace,
        fromCheckpointRef:
          (threadContext.value.baselineCheckpointRef
            ? checkpointRefForThreadTurnInManagedFamily(
                threadContext.value.baselineCheckpointRef,
                input.threadId,
                0,
              )
            : null) ?? checkpointRefForThreadTurn(input.threadId, 0),
        toCheckpointRef: threadContext.value.toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });

      const fullThreadDiff = buildTurnDiffResult({
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
        diff,
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
