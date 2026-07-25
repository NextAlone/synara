import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_CHANNELS, ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WebSocketRequest, WsResponse, WS_CHANNELS, WS_METHODS } from "./ws";

const decode = <S extends Schema.Top>(
  schema: S,
  input: unknown,
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, never> =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WebSocketRequest, {
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts git.preparePullRequestThread requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-pr-1",
      body: {
        _tag: WS_METHODS.gitPreparePullRequestThread,
        cwd: "/repo",
        reference: "#42",
        mode: "worktree",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.gitPreparePullRequestThread);
  }),
);

it.effect("accepts project-scoped VCS reference mutations", () =>
  Effect.gen(function* () {
    const create = yield* decode(WebSocketRequest, {
      id: "req-vcs-create-ref",
      body: {
        _tag: WS_METHODS.vcsCreateReference,
        projectId: "project-1",
        expectedEpoch: 2,
        name: "feature",
        publish: false,
      },
    });
    const switchReference = yield* decode(WebSocketRequest, {
      id: "req-vcs-switch-ref",
      body: {
        _tag: WS_METHODS.vcsSwitchReference,
        projectId: "project-1",
        threadId: "thread-1",
        expectedEpoch: 2,
        ref: "feature",
      },
    });

    assert.strictEqual(create.body._tag, WS_METHODS.vcsCreateReference);
    assert.strictEqual(switchReference.body._tag, WS_METHODS.vcsSwitchReference);
  }),
);

it.effect("accepts project-scoped VCS pull request preparation", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-vcs-pr-1",
      body: {
        _tag: WS_METHODS.vcsPreparePullRequestThread,
        projectId: "project-1",
        expectedEpoch: 2,
        reference: "#42",
        mode: "workspace",
      },
    });

    assert.strictEqual(parsed.body._tag, WS_METHODS.vcsPreparePullRequestThread);
  }),
);

it.effect("accepts project script discovery requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-project-scripts-1",
      body: {
        _tag: WS_METHODS.projectsDiscoverScripts,
        cwd: "/repo",
        depth: 1,
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.projectsDiscoverScripts);
  }),
);

it.effect("accepts automation create requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-automation-create-1",
      body: {
        _tag: WS_METHODS.automationCreate,
        name: "Nightly maintenance",
        projectId: "project-1",
        prompt: "Check stale dependencies.",
        schedule: { type: "manual" },
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.automationCreate);
  }),
);

it.effect("accepts automation proposal resolution requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WebSocketRequest, {
      id: "req-automation-proposal-1",
      body: {
        _tag: WS_METHODS.automationResolveProposal,
        automationId: "automation-1",
        resolution: "accepted",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.automationResolveProposal);
  }),
);

it.effect("accepts automation run action requests", () =>
  Effect.gen(function* () {
    const markRead = yield* decode(WebSocketRequest, {
      id: "req-automation-read-1",
      body: {
        _tag: WS_METHODS.automationMarkRunRead,
        runId: "run-1",
        unread: false,
      },
    });
    const archive = yield* decode(WebSocketRequest, {
      id: "req-automation-archive-1",
      body: {
        _tag: WS_METHODS.automationArchiveRun,
        runId: "run-1",
        archived: true,
      },
    });

    assert.strictEqual(markRead.body._tag, WS_METHODS.automationMarkRunRead);
    assert.strictEqual(archive.body._tag, WS_METHODS.automationArchiveRun);
  }),
);

it.effect("accepts typed websocket push envelopes with sequence", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 1,
      channel: WS_CHANNELS.serverWelcome,
      data: {
        cwd: "/tmp/workspace",
        projectName: "workspace",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.type, "push");
    assert.strictEqual(parsed.sequence, 1);
    assert.strictEqual(parsed.channel, WS_CHANNELS.serverWelcome);
  }),
);

it.effect("accepts git.actionProgress push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 3,
      channel: WS_CHANNELS.gitActionProgress,
      data: {
        actionId: "action-1",
        cwd: "/repo",
        action: "commit",
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.gitActionProgress);
  }),
);

it.effect("accepts automation.event push envelopes", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(WsResponse, {
      type: "push",
      sequence: 4,
      channel: WS_CHANNELS.automationEvent,
      data: {
        type: "definition-deleted",
        automationId: "automation-1",
      },
    });

    if (!("type" in parsed) || parsed.type !== "push") {
      assert.fail("expected websocket response to decode as a push envelope");
    }

    assert.strictEqual(parsed.channel, WS_CHANNELS.automationEvent);
  }),
);

it.effect("rejects push envelopes when channel payload does not match the channel schema", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decode(WsResponse, {
        type: "push",
        sequence: 2,
        channel: ORCHESTRATION_WS_CHANNELS.domainEvent,
        data: {
          cwd: "/tmp/workspace",
          projectName: "workspace",
        },
      }),
    );

    assert.strictEqual(result._tag, "Failure");
  }),
);
