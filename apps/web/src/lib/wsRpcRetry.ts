// FILE: wsRpcRetry.ts
// Purpose: Shared retry classification for typed WebSocket RPC admission errors.
// Layer: Web data fetching helpers

export const EXPENSIVE_READ_CAPACITY_MAX_FAILURE_COUNT = 12;
export const EXPENSIVE_READ_CAPACITY_BASE_DELAY_MS = 250;
export const EXPENSIVE_READ_CAPACITY_MAX_BACKOFF_MS = 2_000;

export interface RpcErrorLike {
  readonly code?: unknown;
  readonly retryable?: unknown;
  readonly retryAfterMs?: unknown;
  readonly cause?: unknown;
}

function findNestedError(
  error: unknown,
  predicate: (candidate: RpcErrorLike) => boolean,
): RpcErrorLike | null {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return null;
    }
    seen.add(current);
    const candidate = current as RpcErrorLike;
    if (predicate(candidate)) return candidate;
    current = candidate.cause;
  }
  return null;
}

function retryableExpensiveReadCapacityError(error: unknown): RpcErrorLike | null {
  return findNestedError(
    error,
    (candidate) =>
      candidate.code === "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED" && candidate.retryable === true,
  );
}

export function isRetryableExpensiveReadCapacityError(error: unknown): boolean {
  return retryableExpensiveReadCapacityError(error) !== null;
}

export function shouldRetryExpensiveReadCapacity(failureCount: number, error: unknown): boolean {
  return (
    failureCount < EXPENSIVE_READ_CAPACITY_MAX_FAILURE_COUNT &&
    isRetryableExpensiveReadCapacityError(error)
  );
}

export function expensiveReadCapacityRetryDelayMs(
  attemptIndex: number,
  error: unknown,
): number | null {
  const capacityError = retryableExpensiveReadCapacityError(error);
  if (!capacityError) return null;
  const serverFloor =
    typeof capacityError.retryAfterMs === "number" && capacityError.retryAfterMs >= 0
      ? capacityError.retryAfterMs
      : EXPENSIVE_READ_CAPACITY_BASE_DELAY_MS;
  const backoff = Math.min(
    EXPENSIVE_READ_CAPACITY_MAX_BACKOFF_MS,
    EXPENSIVE_READ_CAPACITY_BASE_DELAY_MS * 2 ** Math.max(0, attemptIndex),
  );
  return Math.max(serverFloor, backoff);
}

export function isWsRequestCancelled(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return findNestedError(error, (candidate) => candidate.code === "WS_REQUEST_ABORTED") !== null;
}
