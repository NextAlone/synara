import {
  GitHandoffThreadInput,
  GitHandoffThreadResult,
  VcsHandoffThreadInput,
  VcsHandoffThreadResult,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Data, Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

type HandoffPhase = "pending" | "git_applied" | "completed" | "uncertain";

interface HandoffRow {
  readonly commandId: string;
  readonly threadId: string;
  readonly inputJson: string;
  readonly phase: HandoffPhase;
  readonly resultJson: string | null;
}

export type GitHandoffOperation =
  | { readonly phase: "new" }
  | { readonly phase: "pending" | "uncertain" }
  | {
      readonly phase: "git_applied" | "completed";
      readonly result: GitHandoffThreadResult;
    };

export type VcsHandoffOperation =
  | { readonly phase: "new" }
  | { readonly phase: "pending" | "uncertain" }
  | {
      readonly phase: "git_applied" | "completed";
      readonly result: VcsHandoffThreadResult;
    };

export class GitHandoffOperationError extends Data.TaggedError("GitHandoffOperationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const operationError = (message: string) => (cause: unknown) =>
  new GitHandoffOperationError({ message, cause });

const parseResult = (row: HandoffRow) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(GitHandoffThreadResult)(JSON.parse(row.resultJson ?? "")),
    catch: operationError(`Invalid persisted Git handoff result for ${row.commandId}.`),
  });

const normalizePersistedVcsHandoffMode = (value: unknown): unknown =>
  value === "worktree" ? "workspace" : value;

const normalizePersistedVcsHandoffInput = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "targetMode" in value
    ? {
        ...value,
        targetMode: normalizePersistedVcsHandoffMode(value.targetMode),
      }
    : value;

const normalizePersistedVcsHandoffResult = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || !("targetMode" in value)) {
    return value;
  }
  if ("workspacePath" in value) {
    return {
      ...value,
      targetMode: normalizePersistedVcsHandoffMode(value.targetMode),
    };
  }
  return {
    ...value,
    targetMode: normalizePersistedVcsHandoffMode(value.targetMode),
    workspacePath: "worktreePath" in value ? value.worktreePath : undefined,
    associatedWorkspacePath:
      "associatedWorktreePath" in value ? value.associatedWorktreePath : undefined,
    associatedWorkspaceBranch:
      "associatedWorktreeBranch" in value ? value.associatedWorktreeBranch : undefined,
    associatedWorkspaceRef:
      "associatedWorktreeRef" in value ? value.associatedWorktreeRef : undefined,
  };
};

const parseVcsResult = (row: HandoffRow) =>
  Effect.try({
    try: () =>
      Schema.decodeUnknownSync(VcsHandoffThreadResult)(
        normalizePersistedVcsHandoffResult(JSON.parse(row.resultJson ?? "")),
      ),
    catch: operationError(`Invalid persisted VCS handoff result for ${row.commandId}.`),
  });

const readOperation = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<HandoffRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_handoff_operations
      WHERE command_id = ${commandId}
    `.pipe(Effect.mapError(operationError("Failed to read Git handoff operation.")));
    return rows[0] ?? null;
  });

const decodeOperation = (
  row: HandoffRow,
): Effect.Effect<GitHandoffOperation, GitHandoffOperationError> =>
  row.phase === "git_applied" || row.phase === "completed"
    ? parseResult(row).pipe(Effect.map((result) => ({ phase: row.phase, result })))
    : Effect.succeed({ phase: row.phase });

const decodeVcsOperation = (
  row: HandoffRow,
): Effect.Effect<VcsHandoffOperation, GitHandoffOperationError> =>
  row.phase === "git_applied" || row.phase === "completed"
    ? parseVcsResult(row).pipe(Effect.map((result) => ({ phase: row.phase, result })))
    : Effect.succeed({ phase: row.phase });

const beginHandoff = (input: {
  readonly commandId: string;
  readonly threadId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inputJson = JSON.stringify(input);
    const now = new Date().toISOString();
    const inserted = yield* sql<{ readonly commandId: string }>`
      INSERT INTO git_handoff_operations (
        command_id, thread_id, input_json, phase, result_json, created_at, updated_at
      ) VALUES (
        ${input.commandId}, ${input.threadId}, ${inputJson}, 'pending', NULL, ${now}, ${now}
      )
      ON CONFLICT (command_id) DO NOTHING
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to begin VCS handoff operation.")));
    if (inserted.length > 0) return { inputJson, row: null } as const;

    const existing = yield* readOperation(input.commandId);
    if (!existing || existing.threadId !== input.threadId || existing.inputJson !== inputJson) {
      return yield* new GitHandoffOperationError({
        message: `VCS handoff command identity ${input.commandId} was reused with different input.`,
      });
    }
    return { inputJson, row: existing } as const;
  });

export const beginGitHandoff = (input: GitHandoffThreadInput) =>
  Effect.gen(function* () {
    const begun = yield* beginHandoff(input);
    return begun.row === null ? ({ phase: "new" } as const) : yield* decodeOperation(begun.row);
  });

export const beginVcsHandoff = (input: VcsHandoffThreadInput) =>
  Effect.gen(function* () {
    const begun = yield* beginHandoff(input);
    return begun.row === null
      ? ({ phase: "new" } as const)
      : yield* decodeVcsOperation(begun.row);
  });

const recordHandoffResult = (
  commandId: string,
  result: GitHandoffThreadResult | VcsHandoffThreadResult,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const resultJson = JSON.stringify(result);
    const now = new Date().toISOString();
    yield* sql`
      UPDATE git_handoff_operations
      SET phase = 'git_applied', result_json = ${resultJson}, updated_at = ${now}
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(Effect.mapError(operationError("Failed to persist applied VCS handoff result.")));
  });

export const recordGitHandoffResult = (
  commandId: string,
  result: GitHandoffThreadResult,
) => recordHandoffResult(commandId, result);

export const recordVcsHandoffResult = (
  commandId: string,
  result: VcsHandoffThreadResult,
) => recordHandoffResult(commandId, result);

export const completeGitHandoff = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE git_handoff_operations
      SET phase = 'completed', updated_at = ${new Date().toISOString()}
      WHERE command_id = ${commandId} AND phase = 'git_applied'
    `.pipe(Effect.mapError(operationError("Failed to complete Git handoff operation.")));
  });

export const discardPendingGitHandoff = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      DELETE FROM git_handoff_operations
      WHERE command_id = ${commandId} AND phase = 'pending'
    `.pipe(Effect.mapError(operationError("Failed to discard failed Git handoff operation.")));
  });

export const gitHandoffMetadataCommand = (
  input: Pick<GitHandoffThreadInput, "commandId" | "threadId">,
  result: GitHandoffThreadResult,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: input.commandId,
  threadId: input.threadId,
  envMode: result.targetMode,
  branch: result.branch,
  worktreePath: result.worktreePath,
  associatedWorktreePath: result.associatedWorktreePath,
  associatedWorktreeBranch: result.associatedWorktreeBranch,
  associatedWorktreeRef: result.associatedWorktreeRef,
  ...(result.targetMode === "worktree" ? { createBranchFlowCompleted: false } : {}),
});

export const vcsHandoffMetadataCommand = (
  input: Pick<VcsHandoffThreadInput, "commandId" | "threadId">,
  result: VcsHandoffThreadResult,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: input.commandId,
  threadId: input.threadId,
  envMode: result.targetMode === "workspace" ? "worktree" : "local",
  branch: result.branch,
  worktreePath: result.workspacePath,
  associatedWorktreePath: result.associatedWorkspacePath,
  associatedWorktreeBranch: result.associatedWorkspaceBranch,
  associatedWorktreeRef: result.associatedWorkspaceRef,
  ...(result.targetMode === "workspace" ? { createBranchFlowCompleted: false } : {}),
});

export const recoverGitHandoffOperations = (
  dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const interrupted = yield* sql<{ readonly commandId: string }>`
      UPDATE git_handoff_operations
      SET phase = 'uncertain', updated_at = ${new Date().toISOString()}
      WHERE phase = 'pending'
      RETURNING command_id AS "commandId"
    `.pipe(Effect.mapError(operationError("Failed to fence interrupted Git handoffs.")));
    if (interrupted.length > 0) {
      yield* Effect.logWarning("Git handoffs were interrupted before their result was durable", {
        commandIds: interrupted.map(({ commandId }) => commandId),
      });
    }

    const rows = yield* sql<HandoffRow>`
      SELECT
        command_id AS "commandId",
        thread_id AS "threadId",
        input_json AS "inputJson",
        phase,
        result_json AS "resultJson"
      FROM git_handoff_operations
      WHERE phase = 'git_applied'
      ORDER BY updated_at ASC, command_id ASC
    `.pipe(Effect.mapError(operationError("Failed to list recoverable Git handoffs.")));

    for (const row of rows) {
      const rawInput = yield* Effect.try({
        try: () => JSON.parse(row.inputJson) as unknown,
        catch: operationError(`Invalid persisted VCS handoff input for ${row.commandId}.`),
      });
      if (
        typeof rawInput === "object" &&
        rawInput !== null &&
        "projectId" in rawInput
      ) {
        const input = yield* Effect.try({
          try: () =>
            Schema.decodeUnknownSync(VcsHandoffThreadInput)(
              normalizePersistedVcsHandoffInput(rawInput),
            ),
          catch: operationError(`Invalid persisted VCS handoff input for ${row.commandId}.`),
        });
        const result = yield* parseVcsResult(row);
        yield* dispatch(vcsHandoffMetadataCommand(input, result)).pipe(
          Effect.mapError(operationError(`Failed to recover VCS handoff ${row.commandId}.`)),
        );
      } else {
        const input = yield* Effect.try({
          try: () => Schema.decodeUnknownSync(GitHandoffThreadInput)(rawInput),
          catch: operationError(`Invalid persisted Git handoff input for ${row.commandId}.`),
        });
        const result = yield* parseResult(row);
        yield* dispatch(gitHandoffMetadataCommand(input, result)).pipe(
          Effect.mapError(operationError(`Failed to recover Git handoff ${row.commandId}.`)),
        );
      }
      yield* completeGitHandoff(row.commandId);
    }
  });
