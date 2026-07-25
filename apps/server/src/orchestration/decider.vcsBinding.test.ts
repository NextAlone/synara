import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-vcs");
const NOW = "2026-07-25T00:00:00.000Z";

async function projectReadModel(kind: "project" | "studio" = "project") {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(NOW), {
      sequence: 1,
      eventId: EventId.makeUnsafe("evt-project-vcs"),
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      type: "project.created",
      occurredAt: NOW,
      commandId: CommandId.makeUnsafe("cmd-project-vcs"),
      causationEventId: null,
      correlationId: CommandId.makeUnsafe("cmd-project-vcs"),
      metadata: {},
      payload: {
        projectId: PROJECT_ID,
        kind,
        title: "VCS project",
        workspaceRoot: "/tmp/vcs-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  );
}

describe("project VCS binding decider", () => {
  it("stores exactly one backend and advances the stale-request epoch", async () => {
    const initial = await projectReadModel();
    expect(initial.projects[0]?.vcs).toEqual({ epoch: 0, binding: null });

    const first = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.vcs-binding.set",
          commandId: CommandId.makeUnsafe("cmd-bind-jj"),
          projectId: PROJECT_ID,
          expectedEpoch: 0,
          binding: {
            backend: "jj",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
          updatedAt: NOW,
        },
        readModel: initial,
      }),
    );
    expect(Array.isArray(first)).toBe(false);
    if (Array.isArray(first)) {
      throw new Error("Expected project.meta-updated.");
    }
    const firstEvent = first as OrchestrationEvent;
    if (firstEvent.type !== "project.meta-updated") {
      throw new Error("Expected project.meta-updated.");
    }
    expect(firstEvent.payload.vcs).toEqual({
      epoch: 1,
      binding: {
        backend: "jj",
        repoRoot: "/tmp/vcs-project",
        projectRelativePath: ".",
      },
    });

    const bound = await Effect.runPromise(projectEvent(initial, { ...firstEvent, sequence: 2 }));
    expect(bound.projects[0]?.vcs?.binding?.backend).toBe("jj");

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe("cmd-stale-bind-git"),
            projectId: PROJECT_ID,
            expectedEpoch: 0,
            binding: {
              backend: "git",
              repoRoot: "/tmp/vcs-project",
              projectRelativePath: ".",
            },
            updatedAt: NOW,
          },
          readModel: bound,
        }),
      ),
    ).rejects.toThrow("epoch changed from 0 to 1");

    const switched = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.vcs-binding.set",
          commandId: CommandId.makeUnsafe("cmd-bind-git"),
          projectId: PROJECT_ID,
          expectedEpoch: 1,
          binding: {
            backend: "git",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
          updatedAt: NOW,
        },
        readModel: bound,
      }),
    );
    if (Array.isArray(switched)) {
      throw new Error("Expected project.meta-updated.");
    }
    const switchedEvent = switched as OrchestrationEvent;
    if (switchedEvent.type !== "project.meta-updated") {
      throw new Error("Expected project.meta-updated.");
    }
    expect(switchedEvent.payload.vcs).toEqual({
      epoch: 2,
      binding: {
        backend: "git",
        repoRoot: "/tmp/vcs-project",
        projectRelativePath: ".",
      },
    });
  });

  it("clears local thread references when the backend or repository binding changes", async () => {
    const initial = await projectReadModel();
    const gitBindingEvent = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.vcs-binding.set",
          commandId: CommandId.makeUnsafe("cmd-bind-git-before-thread"),
          projectId: PROJECT_ID,
          expectedEpoch: 0,
          binding: {
            backend: "git",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
          updatedAt: NOW,
        },
        readModel: initial,
      }),
    );
    if (Array.isArray(gitBindingEvent)) {
      throw new Error("Expected one binding event.");
    }
    const singleGitBindingEvent = gitBindingEvent as OrchestrationEvent;
    const bound = await Effect.runPromise(
      projectEvent(initial, { ...singleGitBindingEvent, sequence: 2 }),
    );
    const threadId = ThreadId.makeUnsafe("thread-stale-git-reference");
    const withThread = await Effect.runPromise(
      projectEvent(bound, {
        sequence: 3,
        eventId: EventId.makeUnsafe("evt-thread-stale-git-reference"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("cmd-thread-stale-git-reference"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-stale-git-reference"),
        metadata: {},
        payload: {
          threadId,
          projectId: PROJECT_ID,
          title: "Local Git thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "local",
          branch: "feature/git",
          worktreePath: null,
          associatedWorktreePath: "/tmp/old-git-worktree",
          associatedWorktreeBranch: "feature/git",
          associatedWorktreeRef: "old-git-head",
          lastKnownPr: {
            number: 7,
            title: "Same repository pull request",
            url: "https://github.com/example/project/pull/7",
            baseBranch: "main",
            headBranch: "feature/git",
            state: "open",
          },
          handoff: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    for (const scenario of [
      {
        commandId: "cmd-switch-thread-to-jj",
        binding: {
          backend: "jj",
          repoRoot: "/tmp/vcs-project",
          projectRelativePath: ".",
        },
      },
      {
        commandId: "cmd-rebind-thread-to-moved-git",
        binding: {
          backend: "git",
          repoRoot: "/tmp/moved-vcs-project",
          projectRelativePath: ".",
        },
      },
    ] as const) {
      const changed = await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe(scenario.commandId),
            projectId: PROJECT_ID,
            expectedEpoch: 1,
            binding: scenario.binding,
            updatedAt: NOW,
          },
          readModel: withThread,
        }),
      );

      expect(Array.isArray(changed)).toBe(true);
      if (!Array.isArray(changed)) {
        throw new Error("Expected project and thread events.");
      }
      expect(changed).toHaveLength(2);
      expect(changed[0]).toMatchObject({
        type: "project.meta-updated",
        payload: {
          vcs: {
            epoch: 2,
            binding: scenario.binding,
          },
        },
      });
      expect(changed[1]).toMatchObject({
        type: "thread.meta-updated",
        aggregateId: threadId,
        causationEventId: changed[0]?.eventId,
        payload: {
          threadId,
          branch: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
        },
      });
      if (scenario.binding.repoRoot === "/tmp/vcs-project") {
        expect(changed[1]?.payload).not.toHaveProperty("lastKnownPr");
      } else {
        expect(changed[1]?.payload).toHaveProperty("lastKnownPr", null);
      }
    }
  });

  it("keeps existing Git worktrees bindable during migration but blocks an initial JJ binding", async () => {
    const initial = await projectReadModel();
    const threadId = ThreadId.makeUnsafe("thread-existing-git-worktree");
    const withThread = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 2,
        eventId: EventId.makeUnsafe("evt-existing-git-worktree"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("cmd-existing-git-worktree"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-existing-git-worktree"),
        metadata: {},
        payload: {
          threadId,
          projectId: PROJECT_ID,
          title: "Existing Git worktree",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "worktree",
          branch: "feature/git",
          worktreePath: "/tmp/existing-git-worktree",
          handoff: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    const gitBinding = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.vcs-binding.set",
          commandId: CommandId.makeUnsafe("cmd-bind-existing-git-worktree"),
          projectId: PROJECT_ID,
          expectedEpoch: 0,
          binding: {
            backend: "git",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
          updatedAt: NOW,
        },
        readModel: withThread,
      }),
    );
    expect(Array.isArray(gitBinding)).toBe(false);
    expect(gitBinding).toMatchObject({
      type: "project.meta-updated",
      payload: {
        vcs: {
          epoch: 1,
          binding: {
            backend: "git",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
        },
      },
    });

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe("cmd-bind-existing-worktree-to-jj"),
            projectId: PROJECT_ID,
            expectedEpoch: 0,
            binding: {
              backend: "jj",
              repoRoot: "/tmp/vcs-project",
              projectRelativePath: ".",
            },
            updatedAt: NOW,
          },
          readModel: withThread,
        }),
      ),
    ).rejects.toThrow("Move or remove 1 existing worktree thread");
  });

  it("does not allow a backend switch while a turn or checkpoint revert is active", async () => {
    const withProject = await projectReadModel();
    const threadId = ThreadId.makeUnsafe("thread-vcs");
    const withThread = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: EventId.makeUnsafe("evt-thread-vcs"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("cmd-thread-vcs"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-vcs"),
        metadata: {},
        payload: {
          threadId,
          projectId: PROJECT_ID,
          title: "Active thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "local",
          branch: null,
          worktreePath: null,
          handoff: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );
    const active = {
      ...withThread,
      threads: withThread.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-vcs"),
                state: "running" as const,
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: null,
                assistantMessageId: null,
              },
            }
          : thread,
      ),
    };

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe("cmd-active-bind"),
            projectId: PROJECT_ID,
            expectedEpoch: 0,
            binding: {
              backend: "jj",
              repoRoot: "/tmp/vcs-project",
              projectRelativePath: ".",
            },
            updatedAt: NOW,
          },
          readModel: active,
        }),
      ),
    ).rejects.toThrow("has an active turn");

    const reverting = {
      ...withThread,
      threads: withThread.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              activities: [
                {
                  id: EventId.makeUnsafe("evt-vcs-revert-started"),
                  tone: "info" as const,
                  kind: "checkpoint.revert.started",
                  summary: "Reverting checkpoint",
                  payload: { turnCount: 1 },
                  turnId: null,
                  sequence: 3,
                  createdAt: NOW,
                },
              ],
            }
          : thread,
      ),
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe("cmd-reverting-bind"),
            projectId: PROJECT_ID,
            expectedEpoch: 0,
            binding: {
              backend: "jj",
              repoRoot: "/tmp/vcs-project",
              projectRelativePath: ".",
            },
            updatedAt: NOW,
          },
          readModel: reverting,
        }),
      ),
    ).rejects.toThrow("checkpoint revert in progress");
  });

  it("rejects repository bindings on non-project containers", async () => {
    const studio = await projectReadModel("studio");
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.vcs-binding.set",
            commandId: CommandId.makeUnsafe("cmd-studio-bind"),
            projectId: PROJECT_ID,
            expectedEpoch: 0,
            binding: {
              backend: "jj",
              repoRoot: "/tmp/vcs-project",
              projectRelativePath: ".",
            },
            updatedAt: NOW,
          },
          readModel: studio,
        }),
      ),
    ).rejects.toThrow("Only ordinary projects");
  });

  it("invalidates the binding safely when the project root changes", async () => {
    const initial = await projectReadModel();
    const bindingEvent = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.vcs-binding.set",
          commandId: CommandId.makeUnsafe("cmd-bind-before-root-change"),
          projectId: PROJECT_ID,
          expectedEpoch: 0,
          binding: {
            backend: "jj",
            repoRoot: "/tmp/vcs-project",
            projectRelativePath: ".",
          },
          updatedAt: NOW,
        },
        readModel: initial,
      }),
    );
    if (Array.isArray(bindingEvent)) {
      throw new Error("Expected one binding event.");
    }
    const singleBindingEvent = bindingEvent as OrchestrationEvent;
    const bound = await Effect.runPromise(
      projectEvent(initial, { ...singleBindingEvent, sequence: 2 }),
    );
    const threadId = ThreadId.makeUnsafe("thread-root-change");
    const withThread = await Effect.runPromise(
      projectEvent(bound, {
        sequence: 3,
        eventId: EventId.makeUnsafe("evt-thread-root-change"),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: NOW,
        commandId: CommandId.makeUnsafe("cmd-thread-root-change"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-root-change"),
        metadata: {},
        payload: {
          threadId,
          projectId: PROJECT_ID,
          title: "Local JJ thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "local",
          branch: "feature/jj",
          worktreePath: null,
          associatedWorktreePath: "/tmp/old-jj-workspace",
          associatedWorktreeBranch: "feature/jj",
          associatedWorktreeRef: "old-jj-change",
          lastKnownPr: {
            number: 42,
            title: "Old repository pull request",
            url: "https://github.com/example/old/pull/42",
            baseBranch: "main",
            headBranch: "feature/jj",
            state: "open",
          },
          handoff: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    );

    const rootChanged = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.makeUnsafe("cmd-change-project-root"),
          projectId: PROJECT_ID,
          workspaceRoot: "/tmp/vcs-project-moved",
        },
        readModel: withThread,
      }),
    );
    if (!Array.isArray(rootChanged)) {
      throw new Error("Expected project and thread events.");
    }
    expect(rootChanged).toHaveLength(2);
    expect(rootChanged[0]).toMatchObject({
      type: "project.meta-updated",
      payload: {
        workspaceRoot: "/tmp/vcs-project-moved",
        vcs: { epoch: 2, binding: null },
      },
    });
    expect(rootChanged[1]).toMatchObject({
      type: "thread.meta-updated",
      aggregateId: threadId,
      causationEventId: rootChanged[0]?.eventId,
      payload: {
        threadId,
        branch: null,
        associatedWorktreePath: null,
        associatedWorktreeBranch: null,
        associatedWorktreeRef: null,
        lastKnownPr: null,
      },
    });

    const active = {
      ...withThread,
      threads: withThread.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              latestTurn: {
                turnId: TurnId.makeUnsafe("turn-root-change"),
                state: "running" as const,
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: null,
                assistantMessageId: null,
              },
            }
          : thread,
      ),
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-change-active-project-root"),
            projectId: PROJECT_ID,
            workspaceRoot: "/tmp/vcs-project-active-move",
          },
          readModel: active,
        }),
      ),
    ).rejects.toThrow("has an active turn");

    const withWorktreeThread = {
      ...withThread,
      threads: withThread.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              envMode: "worktree" as const,
              worktreePath: "/tmp/jj-workspace",
            }
          : thread,
      ),
    };
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.makeUnsafe("cmd-change-worktree-project-root"),
            projectId: PROJECT_ID,
            workspaceRoot: "/tmp/vcs-project-worktree-move",
          },
          readModel: withWorktreeThread,
        }),
      ),
    ).rejects.toThrow("Move or remove 1 existing worktree thread");
  });
});
