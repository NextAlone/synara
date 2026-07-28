import { PROJECT_FILE_BINARY_ERROR_CODE } from "@synara/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "~/nativeApi";

import {
  isProjectUnsupportedBinaryFileResult,
  isLocalPreviewGrantUsable,
  LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS,
  localPreviewGrantRefetchIntervalMs,
  projectLocalPreviewGrantQueryOptions,
  projectReadFileQueryOptions,
} from "./projectReactQuery";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("local preview grant query options", () => {
  it("refreshes active preview grants before the server-side token expires", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 120_000).toISOString() },
        nowMs,
      ),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs + 20_000).toISOString() },
        nowMs,
      ),
    ).toBe(5_000);
    expect(
      localPreviewGrantRefetchIntervalMs(
        { expiresAt: new Date(nowMs - 1_000).toISOString() },
        nowMs,
      ),
    ).toBe(1_000);
  });

  it("does not treat expired cached grants as usable preview URLs", () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);

    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 2_000).toISOString() }, nowMs),
    ).toBe(true);
    expect(
      isLocalPreviewGrantUsable({ expiresAt: new Date(nowMs + 500).toISOString() }, nowMs),
    ).toBe(false);
  });

  it("wires the refresh interval into the React Query options", () => {
    const options = projectLocalPreviewGrantQueryOptions({ path: "/Users/me/Downloads/shot.png" });
    const refetchInterval = options.refetchInterval;

    expect(typeof refetchInterval).toBe("function");
    if (typeof refetchInterval !== "function") {
      throw new Error("Expected refetchInterval to be a function.");
    }
    expect(
      refetchInterval({
        state: { data: { grant: "grant-token", expiresAt: "not-a-date" } },
      } as never),
    ).toBe(LOCAL_PREVIEW_GRANT_MAX_REFETCH_INTERVAL_MS);
  });
});

describe("workspace file read query options", () => {
  it("normalizes the typed binary RPC error into a cacheable result", async () => {
    const readFile = vi.fn().mockRejectedValue({
      code: PROJECT_FILE_BINARY_ERROR_CODE,
      message: "Workspace file is binary and cannot be previewed.",
      resourcePath: "build/outputs/app.apk",
    });
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readFile },
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const result = await queryClient.fetchQuery(
      projectReadFileQueryOptions({
        cwd: "/repo/app",
        relativePath: "build/app.apk",
      }),
    );

    expect(result).toEqual({
      kind: "unsupported-binary",
      relativePath: "build/outputs/app.apk",
    });
    expect(isProjectUnsupportedBinaryFileResult(result)).toBe(true);
    expect(readFile).toHaveBeenCalledOnce();
    expect(readFile).toHaveBeenCalledWith(expect.anything(), {
      signal: expect.any(AbortSignal),
      priority: "interactive",
    });
  });

  it("keeps ordinary read failures as errors for the preview UI", async () => {
    const readError = new Error("Permission denied");
    vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
      projects: { readFile: vi.fn().mockRejectedValue(readError) },
    } as never);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await expect(
      queryClient.fetchQuery({
        ...projectReadFileQueryOptions({
          cwd: "/repo/app",
          relativePath: "src/app.ts",
        }),
        retry: false,
      }),
    ).rejects.toBe(readError);
  });

  it("uses the extended bounded policy only for typed retryable capacity errors", () => {
    const options = projectReadFileQueryOptions({
      cwd: "/repo/app",
      relativePath: "src/app.ts",
    });
    const retry = options.retry;
    expect(typeof retry).toBe("function");
    if (typeof retry !== "function") {
      throw new Error("Expected retry to be a function.");
    }

    const capacity = {
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
    };
    expect(retry(11, capacity)).toBe(true);
    expect(retry(12, capacity)).toBe(false);
    expect(retry(11, { cause: capacity })).toBe(true);
    expect(retry(3, { ...capacity, retryable: false })).toBe(false);
    expect(retry(2, new Error("ordinary failure"))).toBe(true);
    expect(retry(3, new Error("ordinary failure"))).toBe(false);
    expect(retry(0, { cause: { code: "WS_REQUEST_ABORTED" } })).toBe(false);
  });

  it("backs capacity retries off from the server floor with a two-second cap", () => {
    const options = projectReadFileQueryOptions({
      cwd: "/repo/app",
      relativePath: "src/app.ts",
    });
    const retryDelay = options.retryDelay;
    expect(typeof retryDelay).toBe("function");
    if (typeof retryDelay !== "function") {
      throw new Error("Expected retryDelay to be a function.");
    }
    const capacity = {
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 250,
    };

    expect(retryDelay(0, capacity)).toBe(250);
    expect(retryDelay(1, capacity)).toBe(500);
    expect(retryDelay(4, capacity)).toBe(2_000);
    expect(retryDelay(1, { ...capacity, retryAfterMs: 735 })).toBe(735);
    expect(retryDelay(2, new Error("ordinary failure"))).toBe(4_000);
  });
});
