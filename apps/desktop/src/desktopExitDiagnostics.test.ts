// FILE: desktopExitDiagnostics.test.ts
// Purpose: Verifies durable main-process exit evidence across desktop relaunches.
// Layer: Desktop diagnostics tests

import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DesktopExitDiagnostics,
  readDesktopRunMarker,
  resolveDesktopRunMarkerPath,
  type DesktopMainMemorySnapshot,
  type DesktopRunMarker,
} from "./desktopExitDiagnostics";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-desktop-exit-diagnostics-"));
  temporaryDirectories.push(directory);
  return directory;
}

function makeClock(start = "2026-07-29T07:43:00.000Z"): () => string {
  let timestamp = Date.parse(start);
  return () => {
    const value = new Date(timestamp).toISOString();
    timestamp += 1_000;
    return value;
  };
}

function memory(overrides: Partial<DesktopMainMemorySnapshot> = {}): DesktopMainMemorySnapshot {
  return {
    rss: 100,
    heapTotal: 80,
    heapUsed: 60,
    external: 20,
    arrayBuffers: 10,
    ...overrides,
  };
}

function createDiagnostics(
  markerPath: string,
  runId: string,
  clock = makeClock(),
): DesktopExitDiagnostics {
  return new DesktopExitDiagnostics({
    markerPath,
    runId,
    appVersion: "0.6.3",
    pid: 12_345,
    ppid: 678,
    platform: "darwin",
    arch: "arm64",
    now: clock,
  });
}

function readMarker(markerPath: string): DesktopRunMarker {
  const result = readDesktopRunMarker(markerPath);
  if (result.status !== "valid") {
    throw new Error(`Expected valid marker, received ${result.status}.`);
  }
  return result.marker;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopExitDiagnostics", () => {
  it("writes a private atomic running marker with a current and peak memory snapshot", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    const diagnostics = createDiagnostics(markerPath, "first-run");

    diagnostics.recordHeartbeat({
      uptimeSeconds: 12.5,
      memory: memory({ rss: 200, heapUsed: 150 }),
    });
    diagnostics.recordHeartbeat({
      uptimeSeconds: 20,
      memory: memory({ rss: 120, external: 30 }),
    });

    expect(FS.readdirSync(directory)).toEqual(["desktop-run.json"]);
    expect(readMarker(markerPath)).toMatchObject({
      runId: "first-run",
      phase: "running",
      lastHeartbeat: {
        uptimeSeconds: 20,
        memory: memory({ rss: 120, external: 30 }),
      },
      peakMemory: memory({ rss: 200, heapUsed: 150, external: 30 }),
    });
  });

  it("recognizes a run that reached Electron quit as completed", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    const first = createDiagnostics(markerPath, "first-run");

    first.recordExitIntent("before-quit");
    first.recordEvent("shutdown-complete", "before-quit");
    first.recordCompleted(0);

    const second = createDiagnostics(markerPath, "second-run");

    expect(second.previousRun).toMatchObject({
      kind: "completed",
      marker: { runId: "first-run", phase: "completed", processExit: { code: 0 } },
    });
    expect(readMarker(markerPath)).toMatchObject({ runId: "second-run", phase: "running" });
  });

  it("identifies a stopped run with fault and heartbeat evidence that never reached Electron quit", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    const first = createDiagnostics(markerPath, "first-run");

    first.recordHeartbeat({
      uptimeSeconds: 90,
      memory: memory({ rss: 300, heapUsed: 220 }),
    });
    first.recordFault("renderer-process-gone", "reason=crashed exitCode=9");

    const second = createDiagnostics(markerPath, "second-run");

    expect(second.previousRun).toMatchObject({
      kind: "unclean",
      marker: {
        runId: "first-run",
        phase: "running",
        lastFault: { name: "renderer-process-gone", detail: "reason=crashed exitCode=9" },
        lastHeartbeat: { uptimeSeconds: 90, memory: { rss: 300, heapUsed: 220 } },
        peakMemory: { rss: 300, heapUsed: 220 },
      },
    });
  });

  it("distinguishes a forced interruption after a visible exit request", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    const first = createDiagnostics(markerPath, "first-run");

    first.recordExitIntent("SIGTERM");

    const second = createDiagnostics(markerPath, "second-run");

    expect(second.previousRun).toMatchObject({
      kind: "interrupted-exit",
      marker: {
        runId: "first-run",
        phase: "exit-requested",
        exitIntent: { reason: "SIGTERM" },
      },
    });
  });

  it("retains a fatal event when Node records its exit code", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    const diagnostics = createDiagnostics(markerPath, "first-run");

    diagnostics.recordFault("uncaught-exception", "origin=uncaughtException message=boom");
    diagnostics.recordProcessExit(1);

    expect(readMarker(markerPath)).toMatchObject({
      phase: "running",
      lastEvent: { name: "uncaught-exception" },
      lastFault: { name: "uncaught-exception" },
      processExit: { code: 1 },
    });
  });

  it("reports malformed prior evidence without accepting it as a completed exit", () => {
    const directory = makeTemporaryDirectory();
    const markerPath = resolveDesktopRunMarkerPath(directory);
    FS.writeFileSync(markerPath, "{invalid-json", "utf8");

    const diagnostics = createDiagnostics(markerPath, "second-run");

    expect(diagnostics.previousRun).toMatchObject({ kind: "invalid" });
    expect(readMarker(markerPath)).toMatchObject({ runId: "second-run", phase: "running" });
  });
});
