import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationLatestTurn,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { type Thread } from "../types";
import {
  buildThreadHandoffImportedActivities,
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffModelSelection,
  resolveThreadHandoffSource,
  resolveThreadHandoffTitle,
} from "./threadHandoff";

const timestamp = (second: number): string =>
  `2026-07-26T00:00:${String(second).padStart(2, "0")}.000Z`;

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly second: number;
  readonly turnId?: string | null;
  readonly streaming?: boolean;
  readonly source?: NonNullable<Thread["messages"][number]["source"]>;
}): Thread["messages"][number] {
  return {
    id: MessageId.makeUnsafe(input.id),
    role: input.role,
    text: input.text,
    turnId: input.turnId ? TurnId.makeUnsafe(input.turnId) : null,
    createdAt: timestamp(input.second),
    streaming: input.streaming ?? false,
    source: input.source ?? "native",
  };
}

function latestTurn(input: {
  readonly id: string;
  readonly state: OrchestrationLatestTurn["state"];
  readonly assistantMessageId: string | null;
  readonly requestedAtSecond: number;
  readonly startedAtSecond?: number | null;
  readonly completedAtSecond?: number | null;
}): OrchestrationLatestTurn {
  return {
    turnId: TurnId.makeUnsafe(input.id),
    state: input.state,
    requestedAt: timestamp(input.requestedAtSecond),
    startedAt:
      input.startedAtSecond === null
        ? null
        : timestamp(input.startedAtSecond ?? input.requestedAtSecond),
    completedAt:
      input.completedAtSecond === null
        ? null
        : timestamp(input.completedAtSecond ?? input.requestedAtSecond + 1),
    assistantMessageId:
      input.assistantMessageId === null
        ? null
        : MessageId.makeUnsafe(input.assistantMessageId),
  };
}

describe("threadHandoff", () => {
  it("keeps a coherent completed latest turn", () => {
    const messages = [
      message({ id: "user-1", role: "user", text: "Question", second: 1 }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "Answer",
        second: 2,
        turnId: "turn-1",
      }),
    ];

    const source = resolveThreadHandoffSource({
      messages,
      latestTurn: latestTurn({
        id: "turn-1",
        state: "completed",
        assistantMessageId: "assistant-1",
        requestedAtSecond: 1,
        startedAtSecond: 1,
        completedAtSecond: 2,
      }),
    });

    expect(source.usesPreviousTurn).toBe(false);
    expect(source.messages.map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
  });

  it("falls back before a streaming interrupted turn", () => {
    const messages = [
      message({ id: "user-1", role: "user", text: "Question", second: 1 }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "Answer",
        second: 2,
        turnId: "turn-1",
      }),
      message({ id: "user-2", role: "user", text: "Broken request", second: 3 }),
      message({
        id: "assistant-2",
        role: "assistant",
        text: "Partial",
        second: 4,
        turnId: "turn-2",
        streaming: true,
      }),
    ];

    const source = resolveThreadHandoffSource({
      messages,
      latestTurn: latestTurn({
        id: "turn-2",
        state: "interrupted",
        assistantMessageId: "assistant-2",
        requestedAtSecond: 3,
        startedAtSecond: 4,
        completedAtSecond: 5,
      }),
    });

    expect(source.usesPreviousTurn).toBe(true);
    expect(source.messages.map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
  });

  it("falls back before a failed turn even when its partial assistant was finalized", () => {
    const messages = [
      message({ id: "user-1", role: "user", text: "Question", second: 1 }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "Answer",
        second: 2,
        turnId: "turn-1",
      }),
      message({ id: "user-2", role: "user", text: "Broken request", second: 3 }),
      message({
        id: "assistant-2",
        role: "assistant",
        text: "Partial but settled",
        second: 4,
        turnId: "turn-2",
      }),
    ];

    const source = resolveThreadHandoffSource({
      messages,
      latestTurn: latestTurn({
        id: "turn-2",
        state: "error",
        assistantMessageId: "assistant-2",
        requestedAtSecond: 3,
        startedAtSecond: 4,
        completedAtSecond: 5,
      }),
    });

    expect(source.usesPreviousTurn).toBe(true);
    expect(source.messages.map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
  });

  it("drops a dangling user message when completed turn metadata is incomplete", () => {
    const messages = [
      message({ id: "user-1", role: "user", text: "Question", second: 1 }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "Answer",
        second: 2,
        turnId: "turn-1",
      }),
      message({ id: "user-2", role: "user", text: "Lost request", second: 3 }),
    ];

    const source = resolveThreadHandoffSource({
      messages,
      latestTurn: latestTurn({
        id: "turn-2",
        state: "completed",
        assistantMessageId: "missing-assistant",
        requestedAtSecond: 3,
        startedAtSecond: 3,
        completedAtSecond: 4,
      }),
    });

    expect(source.usesPreviousTurn).toBe(true);
    expect(source.messages.map(({ id }) => id)).toEqual(["user-1", "assistant-1"]);
  });

  it("allows terminal failed turns to recover past a stale running session", () => {
    const messages = [
      message({ id: "user-1", role: "user", text: "Question", second: 1 }),
      message({
        id: "assistant-1",
        role: "assistant",
        text: "Answer",
        second: 2,
        turnId: "turn-1",
      }),
      message({ id: "user-2", role: "user", text: "Broken request", second: 3 }),
      message({
        id: "assistant-2",
        role: "assistant",
        text: "Partial",
        second: 4,
        turnId: "turn-2",
        streaming: true,
      }),
    ];
    const session = {
      provider: "codex" as const,
      status: "running" as const,
      activeTurnId: TurnId.makeUnsafe("turn-2"),
      createdAt: timestamp(1),
      updatedAt: timestamp(5),
      orchestrationStatus: "running" as const,
    };

    expect(
      canCreateThreadHandoff({
        thread: {
          handoff: null,
          messages,
          session,
          latestTurn: latestTurn({
            id: "turn-2",
            state: "interrupted",
            assistantMessageId: "assistant-2",
            requestedAtSecond: 3,
            startedAtSecond: 4,
            completedAtSecond: 5,
          }),
        },
        hasLiveTurn: true,
        hasPendingApprovals: true,
      }),
    ).toBe(true);

    expect(
      canCreateThreadHandoff({
        thread: {
          handoff: null,
          messages,
          session,
          latestTurn: latestTurn({
            id: "turn-2",
            state: "interrupted",
            assistantMessageId: "assistant-2",
            requestedAtSecond: 3,
            startedAtSecond: 4,
            completedAtSecond: 5,
          }),
        },
        isBusy: true,
      }),
    ).toBe(false);

    expect(
      canCreateThreadHandoff({
        thread: {
          handoff: null,
          messages,
          session,
          latestTurn: latestTurn({
            id: "turn-2",
            state: "running",
            assistantMessageId: "assistant-2",
            requestedAtSecond: 3,
            startedAtSecond: 4,
            completedAtSecond: null,
          }),
        },
        hasLiveTurn: true,
      }),
    ).toBe(false);
  });

  it("reuses imported history when a handoff session fails before producing native chat", () => {
    const messages = [
      message({
        id: "imported-user",
        role: "user",
        text: "Imported question",
        second: 1,
        source: "handoff-import",
      }),
      message({
        id: "imported-assistant",
        role: "assistant",
        text: "Imported answer",
        second: 2,
        source: "handoff-import",
      }),
    ];
    const handoff = {
      sourceThreadId: ThreadId.makeUnsafe("source-thread"),
      sourceProvider: "claudeAgent" as const,
      importedAt: timestamp(1),
      bootstrapStatus: "pending" as const,
    };
    const failedSession = {
      provider: "codex" as const,
      status: "error" as const,
      createdAt: timestamp(1),
      updatedAt: timestamp(3),
      orchestrationStatus: "error" as const,
    };

    expect(
      canCreateThreadHandoff({
        thread: {
          handoff,
          latestTurn: null,
          messages,
          session: failedSession,
        },
      }),
    ).toBe(true);
    expect(
      canCreateThreadHandoff({
        thread: {
          handoff,
          latestTurn: null,
          messages,
          session: {
            ...failedSession,
            status: "ready",
            orchestrationStatus: "ready",
          },
        },
      }),
    ).toBe(false);
  });

  it("does not import a source provider's configured context window", () => {
    const activity = (kind: string): OrchestrationThreadActivity => ({
      id: EventId.makeUnsafe(`activity-${kind}`),
      createdAt: "2026-07-21T00:00:00.000Z",
      tone: "info",
      kind,
      summary: kind,
      payload: {},
      turnId: null,
    });

    const imported = buildThreadHandoffImportedActivities({
      activities: [
        activity("context-window.configured"),
        activity("context-window.updated"),
        activity("tool.started"),
      ],
    });

    expect(imported.map(({ kind }) => kind)).toEqual(["context-window.updated"]);
  });

  it("lists all supported handoff targets except the active provider", () => {
    const providers = [
      "codex",
      "claudeAgent",
      "cursor",
      "antigravity",
      "grok",
      "droid",
      "kilo",
      "opencode",
      "pi",
    ] as const;

    for (const source of providers) {
      expect(resolveAvailableHandoffTargetProviders(source)).toEqual(
        providers.filter((provider) => provider !== source),
      );
    }
  });

  it("preserves the source thread title for the created handoff thread", () => {
    expect(resolveThreadHandoffTitle({ title: "General Greeting" })).toBe("General Greeting");
    expect(resolveThreadHandoffTitle({ title: "  Debug   Grok handoff  " })).toBe(
      "Debug Grok handoff",
    );
  });

  it("prefers sticky model selection for the chosen handoff target", () => {
    const stickySelection = {
      provider: "antigravity",
      model: "Gemini 3.5 Flash",
    } satisfies ModelSelection;

    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-sonnet-4-6",
          },
        },
        targetProvider: "antigravity",
        projectDefaultModelSelection: {
          provider: "antigravity",
          model: "Claude Sonnet 4.6",
        },
        stickyModelSelectionByProvider: {
          antigravity: stickySelection,
        },
      }),
    ).toEqual(stickySelection);
  });

  it("falls back to the resolved provider default model when no sticky or project default exists", () => {
    expect(
      resolveThreadHandoffModelSelection({
        sourceThread: {
          modelSelection: {
            provider: "antigravity",
            model: "Gemini 3.5 Flash",
          },
        },
        targetProvider: "codex",
        projectDefaultModelSelection: null,
        stickyModelSelectionByProvider: {},
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.5",
    });
  });
});
