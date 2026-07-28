import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, WS_METHODS, WsFeatureRpcGroup } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { AutomationService } from "./automation/Services/AutomationService";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "./config";
import { DevServerManager } from "./devServerManager";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment";
import { GitCore } from "./git/Services/GitCore";
import { GitManager } from "./git/Services/GitManager";
import { GitStatusBroadcaster } from "./git/Services/GitStatusBroadcaster";
import { TextGeneration } from "./git/Services/TextGeneration";
import { Keybindings } from "./keybindings";
import { Open } from "./open";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProviderCommandReactor } from "./orchestration/Services/ProviderCommandReactor";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { ExternalMcpService } from "./externalMcp/Services/ExternalMcpService";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProfileStatsQuery } from "./profileStats";
import { PullRequestService } from "./pullRequests/Services/PullRequestService";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";
import { ServerRuntimeStartup } from "./serverRuntimeStartup";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";
import { JjCore } from "./vcs/Services/JjCore";
import { ProjectVcs } from "./vcs/Services/ProjectVcs";
import { ThreadDiagnosticsQuery } from "./diagnostics/Services/ThreadDiagnosticsQuery";
import { WorkspaceEntries } from "./workspace/Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "./workspace/Services/WorkspaceFileSystem";
import { makeWsRpcLayer } from "./wsRpc";
import { WsConnectionSessions } from "./wsConnectionSessions";

const PROJECT_ID = ProjectId.makeUnsafe("project-jj");

const inert = new Proxy(() => Effect.die("unused WS RPC test dependency"), {
  get: () => inert,
}) as never;

function makeTestDependencies(input: {
  readonly cwd: string;
  readonly readWorkingTreeDiffStats: ReturnType<typeof vi.fn>;
}) {
  return Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(AutomationService, inert),
    Layer.succeed(CheckpointDiffQuery, inert),
    Layer.succeed(ServerConfig, inert),
    Layer.succeed(DevServerManager, inert),
    Layer.succeed(ExternalMcpService, inert),
    Layer.succeed(GitCore, inert),
    Layer.succeed(
      GitManager,
      { readWorkingTreeDiffStats: input.readWorkingTreeDiffStats } as never,
    ),
    Layer.succeed(GitStatusBroadcaster, inert),
    Layer.succeed(JjCore, { detectRepository: () => Effect.succeed(null) } as never),
    Layer.succeed(Keybindings, inert),
    Layer.succeed(Open, inert),
    Layer.succeed(OrchestrationEngineService, inert),
    Layer.succeed(ProviderCommandReactor, inert),
    Layer.succeed(
      ProjectionSnapshotQuery,
      {
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [
              {
                id: PROJECT_ID,
                kind: "project",
                workspaceRoot: input.cwd,
                vcs: {
                  epoch: 1,
                  binding: {
                    backend: "jj",
                    repoRoot: input.cwd,
                    projectRelativePath: ".",
                  },
                },
              },
            ],
            threads: [],
          } as never),
      } as never,
    ),
    Layer.succeed(ProjectVcs, inert),
    Layer.succeed(ProviderAdapterRegistry, inert),
    Layer.succeed(ProviderDiscoveryService, inert),
    Layer.succeed(ProviderHealth, inert),
    Layer.succeed(ProviderService, inert),
    Layer.succeed(ProfileStatsQuery, inert),
    Layer.succeed(PullRequestService, inert),
    Layer.succeed(ServerEnvironment, inert),
    Layer.succeed(ServerLifecycleEvents, inert),
    Layer.succeed(ServerRuntimeStartup, inert),
    Layer.succeed(
      ServerSettingsService,
      { getSettings: Effect.succeed({ vcsBackend: "jj" }) } as never,
    ),
    Layer.succeed(TerminalManager, inert),
    Layer.succeed(TextGeneration, inert),
    Layer.succeed(ThreadDiagnosticsQuery, inert),
    Layer.succeed(WorkspaceEntries, inert),
    Layer.succeed(WorkspaceFileSystem, inert),
    Layer.succeed(WsConnectionSessions, { lookup: () => undefined } as never),
  );
}

describe("legacy Git RPC handlers", () => {
  it("rejects working-tree diff stats for a JJ-bound project before Git runs", async () => {
    const cwd = process.cwd();
    const gitStatsExecuted = vi.fn();
    const readWorkingTreeDiffStats = vi.fn(() =>
      Effect.sync(() => {
        gitStatsExecuted();
        return { additions: 0, deletions: 0, fileCount: 0 };
      }),
    );

    const program = Effect.scoped(
      Effect.gen(function* () {
        const handlers = yield* Layer.build(
          makeWsRpcLayer().pipe(
            Layer.provide(makeTestDependencies({ cwd, readWorkingTreeDiffStats })),
          ),
        );
        const handler = yield* WsFeatureRpcGroup.accessHandler(
          WS_METHODS.gitWorkingTreeDiffStats,
        ).pipe(Effect.provide(handlers));
        return yield* handler(
          { cwd, scope: "workingTree" },
          { clientId: 1, requestId: "test" as never, headers: {} as never },
        );
      }),
    );

    await expect(Effect.runPromise(program)).rejects.toMatchObject({
      code: "VCS_BACKEND_MISMATCH",
    });
    expect(gitStatsExecuted).not.toHaveBeenCalled();
  });
});
