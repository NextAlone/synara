import { CommandId, ProjectId, ThreadId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  beginGitHandoff,
  beginVcsHandoff,
  recordGitHandoffResult,
  recordVcsHandoffResult,
  recoverGitHandoffOperations,
} from "./gitHandoffOperations.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

const layer = it.layer(SqlitePersistenceMemory);

const input = {
  commandId: CommandId.makeUnsafe("git-handoff-recovery-command"),
  threadId: ThreadId.makeUnsafe("git-handoff-recovery-thread"),
  cwd: "/repo",
  targetMode: "worktree" as const,
  currentBranch: "main",
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  preferredLocalBranch: null,
  preferredWorktreeBaseBranch: "main",
  preferredNewWorktreeName: "feature/recovery",
};

const result = {
  targetMode: "worktree" as const,
  branch: "feature/recovery",
  worktreePath: "/worktrees/recovery",
  associatedWorktreePath: "/worktrees/recovery",
  associatedWorktreeBranch: "feature/recovery",
  associatedWorktreeRef: "abc123",
  changesTransferred: true,
  conflictsDetected: false,
  message: "Recovered",
};

const vcsInput = {
  commandId: CommandId.makeUnsafe("vcs-handoff-recovery-command"),
  projectId: ProjectId.makeUnsafe("vcs-handoff-recovery-project"),
  threadId: ThreadId.makeUnsafe("vcs-handoff-recovery-thread"),
  expectedEpoch: 3,
  targetMode: "workspace" as const,
  preferredLocalReference: null,
  preferredWorkspaceBaseReference: "main",
  preferredNewWorkspaceName: "feature/recovery",
};

const vcsResult = {
  backend: "jj" as const,
  epoch: 3,
  targetMode: "workspace" as const,
  branch: "feature/recovery",
  workspacePath: "/workspaces/recovery",
  associatedWorkspacePath: "/workspaces/recovery",
  associatedWorkspaceBranch: "feature/recovery",
  associatedWorkspaceRef: "abc123",
  changesTransferred: true,
  conflictsDetected: false,
  message: "Recovered",
};

layer("Git handoff operation recovery", (it) => {
  it.effect(
    "replays durable Git results without running Git again and fences incomplete work",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM git_handoff_operations`;

        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "new" });
        yield* recordGitHandoffResult(input.commandId, result);
        assert.deepStrictEqual(yield* beginGitHandoff(input), {
          phase: "git_applied",
          result,
        });

        const dispatched: unknown[] = [];
        yield* recoverGitHandoffOperations((command) =>
          Effect.sync(() => {
            dispatched.push(command);
          }),
        );
        assert.lengthOf(dispatched, 1);
        assert.deepInclude(dispatched[0] as object, {
          type: "thread.meta.update",
          commandId: input.commandId,
          threadId: input.threadId,
          worktreePath: result.worktreePath,
        });
        assert.deepStrictEqual(yield* beginGitHandoff(input), { phase: "completed", result });

        const interruptedInput = {
          ...input,
          commandId: CommandId.makeUnsafe("git-handoff-interrupted-command"),
        };
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "new" });
        yield* recoverGitHandoffOperations(() => Effect.void);
        assert.deepStrictEqual(yield* beginGitHandoff(interruptedInput), { phase: "uncertain" });
      }),
  );

  it.effect("persists workspace-shaped VCS results and maps them to thread metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM git_handoff_operations`;

      assert.deepStrictEqual(yield* beginVcsHandoff(vcsInput), { phase: "new" });
      yield* recordVcsHandoffResult(vcsInput.commandId, vcsResult);
      assert.deepStrictEqual(yield* beginVcsHandoff(vcsInput), {
        phase: "git_applied",
        result: vcsResult,
      });

      const dispatched: unknown[] = [];
      yield* recoverGitHandoffOperations((command) =>
        Effect.sync(() => {
          dispatched.push(command);
        }),
      );

      assert.lengthOf(dispatched, 1);
      assert.deepInclude(dispatched[0] as object, {
        type: "thread.meta.update",
        envMode: "worktree",
        worktreePath: vcsResult.workspacePath,
        associatedWorktreePath: vcsResult.associatedWorkspacePath,
        associatedWorktreeBranch: vcsResult.associatedWorkspaceBranch,
        associatedWorktreeRef: vcsResult.associatedWorkspaceRef,
      });
    }),
  );

  it.effect("recovers VCS handoffs persisted before the workspace field rename", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM git_handoff_operations`;
      const commandId = CommandId.makeUnsafe("vcs-handoff-legacy-recovery-command");
      const inputJson = JSON.stringify({
        ...vcsInput,
        commandId,
        targetMode: "worktree",
      });
      const resultJson = JSON.stringify({
        backend: "jj",
        epoch: 3,
        targetMode: "worktree",
        branch: "feature/recovery",
        worktreePath: "/workspaces/recovery",
        associatedWorktreePath: "/workspaces/recovery",
        associatedWorktreeBranch: "feature/recovery",
        associatedWorktreeRef: "abc123",
        changesTransferred: true,
        conflictsDetected: false,
        message: "Recovered",
      });
      const now = new Date().toISOString();
      yield* sql`
        INSERT INTO git_handoff_operations (
          command_id, thread_id, input_json, phase, result_json, created_at, updated_at
        ) VALUES (
          ${commandId},
          ${vcsInput.threadId},
          ${inputJson},
          'git_applied',
          ${resultJson},
          ${now},
          ${now}
        )
      `;

      const dispatched: unknown[] = [];
      yield* recoverGitHandoffOperations((command) =>
        Effect.sync(() => {
          dispatched.push(command);
        }),
      );

      assert.lengthOf(dispatched, 1);
      assert.deepInclude(dispatched[0] as object, {
        type: "thread.meta.update",
        envMode: "worktree",
        worktreePath: "/workspaces/recovery",
        associatedWorktreePath: "/workspaces/recovery",
      });
    }),
  );
});
