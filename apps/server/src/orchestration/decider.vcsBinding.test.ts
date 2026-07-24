import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
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
    if (Array.isArray(first) || first.type !== "project.meta-updated") {
      throw new Error("Expected project.meta-updated.");
    }
    expect(first.payload.vcs).toEqual({
      epoch: 1,
      binding: {
        backend: "jj",
        repoRoot: "/tmp/vcs-project",
        projectRelativePath: ".",
      },
    });

    const bound = await Effect.runPromise(projectEvent(initial, { ...first, sequence: 2 }));
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
    if (Array.isArray(switched) || switched.type !== "project.meta-updated") {
      throw new Error("Expected project.meta-updated.");
    }
    expect(switched.payload.vcs).toEqual({
      epoch: 2,
      binding: {
        backend: "git",
        repoRoot: "/tmp/vcs-project",
        projectRelativePath: ".",
      },
    });
  });

  it("does not allow a backend switch while a project turn is active", async () => {
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
});
