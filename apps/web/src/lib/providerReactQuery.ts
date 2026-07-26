// FILE: providerReactQuery.ts
// Purpose: Builds React Query options for provider-backed orchestration RPC calls.
// Layer: Web data fetching helpers
// Depends on: native API bridge, orchestration contracts, and React Query.

import {
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetTurnDiffInput,
  ThreadId,
} from "@synara/contracts";
import { queryOptions } from "@tanstack/react-query";
import { Option, Schema } from "effect";
import { ensureNativeApi } from "../nativeApi";
import {
  EXPENSIVE_READ_CAPACITY_MAX_FAILURE_COUNT,
  expensiveReadCapacityRetryDelayMs,
  isRetryableExpensiveReadCapacityError,
  isWsRequestCancelled,
} from "./wsRpcRetry";

interface CheckpointDiffQueryInput {
  threadId: ThreadId | null;
  fromTurnCount: number | null;
  toTurnCount: number | null;
  ignoreWhitespace: boolean;
  cacheScope?: string | null;
  enabled?: boolean;
}

export const providerQueryKeys = {
  all: ["providers"] as const,
  checkpointDiff: (input: CheckpointDiffQueryInput) =>
    [
      "providers",
      "checkpointDiff",
      input.threadId,
      input.fromTurnCount,
      input.toTurnCount,
      input.ignoreWhitespace,
      input.cacheScope ?? null,
    ] as const,
};

/** Keep polling while placeholder checkpoints are still being written. */
export const CHECKPOINT_DIFF_PENDING_REFETCH_INTERVAL_MS = 2_000;
export const CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS = 12;

function shouldUseFullThreadDiffApi(input: CheckpointDiffQueryInput): boolean {
  return (
    input.fromTurnCount === 0 &&
    typeof input.cacheScope === "string" &&
    input.cacheScope.startsWith("conversation:")
  );
}

function decodeCheckpointDiffRequest(input: CheckpointDiffQueryInput) {
  if (shouldUseFullThreadDiffApi(input)) {
    return Schema.decodeUnknownOption(OrchestrationGetFullThreadDiffInput)({
      threadId: input.threadId,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace: input.ignoreWhitespace,
    }).pipe(Option.map((fields) => ({ kind: "fullThreadDiff" as const, input: fields })));
  }

  return Schema.decodeUnknownOption(OrchestrationGetTurnDiffInput)({
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    ignoreWhitespace: input.ignoreWhitespace,
  }).pipe(Option.map((fields) => ({ kind: "turnDiff" as const, input: fields })));
}

function asCheckpointErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function normalizeCheckpointErrorMessage(error: unknown): string {
  const message = asCheckpointErrorMessage(error).trim();
  if (message.length === 0) {
    return "Failed to load checkpoint diff.";
  }

  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return "Turn diffs are unavailable because this project has no usable source control repository.";
  }

  if (
    lower.includes("checkpoint unavailable for thread") ||
    lower.includes("checkpoint invariant violation")
  ) {
    const separatorIndex = message.indexOf(":");
    if (separatorIndex >= 0) {
      const detail = message.slice(separatorIndex + 1).trim();
      if (detail.length > 0) {
        return detail;
      }
    }
  }

  return message;
}

export function isCheckpointTemporarilyUnavailable(error: unknown): boolean {
  const message = asCheckpointErrorMessage(error).toLowerCase();
  return (
    message.includes("exceeds current turn count") ||
    // Placeholder checkpoint rows can arrive before the checkpoint writer finishes.
    message.includes("checkpoint diff is not available yet")
  );
}

export function resolveCheckpointDiffQueryDisplayState(input: {
  isLoading: boolean;
  isFetching: boolean;
  dataUpdateCount?: number;
  data: unknown;
  error: unknown;
}): { isLoading: boolean; error: string | null; unavailable: string | null } {
  const result =
    input.data && typeof input.data === "object" && "status" in input.data
      ? (input.data as {
          readonly status?: unknown;
          readonly message?: unknown;
        })
      : null;
  const isPending = result?.status === "pending";
  const pendingExhausted =
    isPending &&
    (input.dataUpdateCount ?? 0) >= CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS &&
    !input.isFetching;
  const unavailableFromResult =
    result?.status === "unavailable" && typeof result.message === "string"
      ? result.message
      : null;
  const unavailable = pendingExhausted
    ? "The checkpoint did not become available after waiting."
    : unavailableFromResult;
  const hasData = input.data != null;
  return {
    isLoading:
      (isPending && !pendingExhausted) ||
      input.isLoading ||
      (input.isFetching && !hasData),
    error:
      isPending || unavailable !== null || input.isFetching || input.error == null
        ? null
        : normalizeCheckpointErrorMessage(input.error),
    unavailable,
  };
}

export function checkpointDiffQueryOptions(input: CheckpointDiffQueryInput) {
  const decodedRequest = decodeCheckpointDiffRequest(input);

  return queryOptions({
    queryKey: providerQueryKeys.checkpointDiff(input),
    queryFn: async ({ signal }) => {
      const api = ensureNativeApi();
      if (!input.threadId || decodedRequest._tag === "None") {
        throw new Error("Checkpoint diff is unavailable.");
      }
      if (decodedRequest.value.kind === "fullThreadDiff") {
        return api.orchestration.getFullThreadDiff(decodedRequest.value.input, {
          signal,
          priority: "interactive",
        });
      }
      return api.orchestration.getTurnDiff(decodedRequest.value.input, {
        signal,
        priority: "interactive",
      });
    },
    enabled: (input.enabled ?? true) && !!input.threadId && decodedRequest._tag === "Some",
    // Ready/unavailable checkpoint results are immutable for a cache scope. A
    // pending result is not: keep it stale so reopening the review after polling
    // exhausted performs a fresh read even if the completion event was missed.
    staleTime: (query) => (query.state.data?.status === "pending" ? 0 : Infinity),
    retry: (failureCount, error) => {
      if (isWsRequestCancelled(error)) {
        return false;
      }
      if (isRetryableExpensiveReadCapacityError(error)) {
        return failureCount < EXPENSIVE_READ_CAPACITY_MAX_FAILURE_COUNT;
      }
      if (isCheckpointTemporarilyUnavailable(error)) {
        return failureCount < CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS;
      }
      return failureCount < 3;
    },
    retryDelay: (attempt, error) => {
      const capacityDelay = expensiveReadCapacityRetryDelayMs(attempt, error);
      if (capacityDelay !== null) return capacityDelay;
      return isCheckpointTemporarilyUnavailable(error)
        ? Math.min(5_000, 250 * 2 ** (attempt - 1))
        : Math.min(1_000, 100 * 2 ** (attempt - 1));
    },
    refetchInterval: (query) => {
      const result = query.state.data;
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "pending"
      ) {
        const retryAfterMs =
          "retryAfterMs" in result && typeof result.retryAfterMs === "number"
            ? result.retryAfterMs
            : CHECKPOINT_DIFF_PENDING_REFETCH_INTERVAL_MS;
        return query.state.dataUpdateCount < CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS
          ? retryAfterMs
          : false;
      }
      const temporaryError = query.state.error;
      if (!temporaryError || !isCheckpointTemporarilyUnavailable(temporaryError)) {
        return false;
      }
      const temporaryErrorCount = query.state.errorUpdateCount ?? 0;
      return temporaryErrorCount < CHECKPOINT_DIFF_PENDING_REFETCH_MAX_ATTEMPTS
        ? CHECKPOINT_DIFF_PENDING_REFETCH_INTERVAL_MS
        : false;
    },
  });
}
