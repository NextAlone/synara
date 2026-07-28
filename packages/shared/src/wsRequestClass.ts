// FILE: wsRequestClass.ts
// Purpose: Keeps browser-side scheduling and server-side admission on one RPC classification.
// Layer: Shared WebSocket runtime policy

import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@synara/contracts";

export type WsRequestClass = "control" | "standard" | "expensive-read";

export const WS_REQUEST_CLASS_LIMITS: Readonly<Record<WsRequestClass, number>> = {
  control: 16,
  standard: 12,
  "expensive-read": 2,
};

const CONTROL_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  ORCHESTRATION_WS_METHODS.reconcileProviderDelivery,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalAckOutput,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClose,
  WS_METHODS.serverStopLocalServer,
  WS_METHODS.automationCancelRun,
  WS_METHODS.automationMarkRunRead,
  WS_METHODS.automationArchiveRun,
]);

const EXPENSIVE_READ_METHODS = new Set<string>([
  ORCHESTRATION_WS_METHODS.getSnapshot,
  ORCHESTRATION_WS_METHODS.getThreadDetailSnapshot,
  ORCHESTRATION_WS_METHODS.repairState,
  ORCHESTRATION_WS_METHODS.getTurnDiff,
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_WS_METHODS.replayEvents,
  ORCHESTRATION_WS_METHODS.listProviderDeliveryBlockers,
  WS_METHODS.projectsSearchEntries,
  WS_METHODS.projectsSearchLocalEntries,
  WS_METHODS.projectsReadFile,
  WS_METHODS.studioListThreadOutputs,
  WS_METHODS.filesystemBrowse,
  WS_METHODS.vcsStatus,
  WS_METHODS.vcsReadDiff,
  WS_METHODS.vcsListReferences,
  WS_METHODS.vcsListWorkspaces,
  WS_METHODS.vcsPullRequestSnapshot,
  WS_METHODS.gitStatus,
  WS_METHODS.gitReadWorkingTreeDiff,
  WS_METHODS.gitWorkingTreeDiffStats,
  WS_METHODS.gitSummarizeDiff,
  WS_METHODS.gitPullRequestSnapshot,
  WS_METHODS.serverGetProviderUsageSnapshot,
  WS_METHODS.serverListProviderUsage,
  WS_METHODS.serverGetDiagnostics,
  WS_METHODS.serverGenerateThreadRecap,
  WS_METHODS.serverGenerateAutomationIntent,
  WS_METHODS.serverTranscribeVoice,
  WS_METHODS.statsGetProfileStats,
  WS_METHODS.statsGetProfileTokenStats,
  WS_METHODS.providerCompactThread,
  WS_METHODS.providerListCommands,
  WS_METHODS.providerListSkills,
  WS_METHODS.providerListSkillsCatalog,
  WS_METHODS.providerListPlugins,
  WS_METHODS.providerReadPlugin,
  WS_METHODS.providerListModels,
  WS_METHODS.providerListAgents,
]);

export function classifyWsRequest(method: string): WsRequestClass {
  if (CONTROL_METHODS.has(method)) return "control";
  if (EXPENSIVE_READ_METHODS.has(method)) return "expensive-read";
  return "standard";
}
