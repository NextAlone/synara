// FILE: desktopExitDiagnostics.ts
// Purpose: Persists desktop main-process lifecycle evidence across abrupt exits.
// Layer: Desktop main-process utility

import * as FS from "node:fs";
import * as Path from "node:path";

import { writePrivateTextFileAtomicallySync } from "./atomicFile";

export const DESKTOP_RUN_MARKER_FILE_NAME = "desktop-run.json";

const DESKTOP_RUN_MARKER_SCHEMA_VERSION = 1;
const MAX_EVENT_NAME_LENGTH = 96;
const MAX_EVENT_DETAIL_LENGTH = 768;

export type DesktopRunPhase = "running" | "exit-requested" | "completed";

export interface DesktopMainMemorySnapshot {
  readonly rss: number;
  readonly heapTotal: number;
  readonly heapUsed: number;
  readonly external: number;
  readonly arrayBuffers: number;
}

export interface DesktopRunEvent {
  readonly at: string;
  readonly name: string;
  readonly detail: string | null;
}

export interface DesktopRunHeartbeat {
  readonly at: string;
  readonly uptimeSeconds: number;
  readonly memory: DesktopMainMemorySnapshot;
}

export interface DesktopRunExitIntent {
  readonly at: string;
  readonly reason: string;
}

export interface DesktopRunProcessExit {
  readonly at: string;
  readonly code: number;
}

export interface DesktopRunMarker {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly pid: number;
  readonly ppid: number;
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly phase: DesktopRunPhase;
  readonly lastEvent: DesktopRunEvent;
  readonly lastFault: DesktopRunEvent | null;
  readonly lastHeartbeat: DesktopRunHeartbeat | null;
  readonly peakMemory: DesktopMainMemorySnapshot | null;
  readonly exitIntent: DesktopRunExitIntent | null;
  readonly completedAt: string | null;
  readonly processExit: DesktopRunProcessExit | null;
}

export type DesktopRunMarkerReadResult =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly marker: DesktopRunMarker }
  | { readonly status: "invalid"; readonly error: string };

export type PreviousDesktopRun =
  | { readonly kind: "none" }
  | { readonly kind: "completed"; readonly marker: DesktopRunMarker }
  | { readonly kind: "interrupted-exit"; readonly marker: DesktopRunMarker }
  | { readonly kind: "unclean"; readonly marker: DesktopRunMarker }
  | { readonly kind: "invalid"; readonly error: string };

export interface DesktopExitDiagnosticsOptions {
  readonly markerPath: string;
  readonly runId: string;
  readonly appVersion: string;
  readonly pid: number;
  readonly ppid: number;
  readonly platform: string;
  readonly arch: string;
  readonly now?: () => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isDesktopMainMemorySnapshot(value: unknown): value is DesktopMainMemorySnapshot {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    isNonNegativeFiniteNumber(value.rss) &&
    isNonNegativeFiniteNumber(value.heapTotal) &&
    isNonNegativeFiniteNumber(value.heapUsed) &&
    isNonNegativeFiniteNumber(value.external) &&
    isNonNegativeFiniteNumber(value.arrayBuffers)
  );
}

function isDesktopRunEvent(value: unknown): value is DesktopRunEvent {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    isIsoTimestamp(value.at) &&
    isNonEmptyString(value.name) &&
    value.name.length <= MAX_EVENT_NAME_LENGTH &&
    (value.detail === null ||
      (typeof value.detail === "string" && value.detail.length <= MAX_EVENT_DETAIL_LENGTH))
  );
}

function isDesktopRunHeartbeat(value: unknown): value is DesktopRunHeartbeat {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    isIsoTimestamp(value.at) &&
    isNonNegativeFiniteNumber(value.uptimeSeconds) &&
    isDesktopMainMemorySnapshot(value.memory)
  );
}

function isDesktopRunExitIntent(value: unknown): value is DesktopRunExitIntent {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    isIsoTimestamp(value.at) &&
    isNonEmptyString(value.reason) &&
    value.reason.length <= MAX_EVENT_DETAIL_LENGTH
  );
}

function isDesktopRunProcessExit(value: unknown): value is DesktopRunProcessExit {
  if (!isPlainRecord(value)) {
    return false;
  }
  return isIsoTimestamp(value.at) && Number.isSafeInteger(value.code);
}

export function isDesktopRunMarker(value: unknown): value is DesktopRunMarker {
  if (!isPlainRecord(value)) {
    return false;
  }
  const phase = value.phase;
  if (phase !== "running" && phase !== "exit-requested" && phase !== "completed") {
    return false;
  }
  if (
    value.schemaVersion !== DESKTOP_RUN_MARKER_SCHEMA_VERSION ||
    !isNonEmptyString(value.runId) ||
    !isIsoTimestamp(value.startedAt) ||
    !isIsoTimestamp(value.updatedAt) ||
    !isNonNegativeInteger(value.pid) ||
    !isNonNegativeInteger(value.ppid) ||
    !isNonEmptyString(value.appVersion) ||
    !isNonEmptyString(value.platform) ||
    !isNonEmptyString(value.arch) ||
    !isDesktopRunEvent(value.lastEvent) ||
    !(value.lastFault === null || isDesktopRunEvent(value.lastFault)) ||
    !(value.lastHeartbeat === null || isDesktopRunHeartbeat(value.lastHeartbeat)) ||
    !(value.peakMemory === null || isDesktopMainMemorySnapshot(value.peakMemory)) ||
    !(value.exitIntent === null || isDesktopRunExitIntent(value.exitIntent)) ||
    !(value.processExit === null || isDesktopRunProcessExit(value.processExit))
  ) {
    return false;
  }
  return phase === "completed" ? isIsoTimestamp(value.completedAt) : value.completedAt === null;
}

function formatReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeEventText(value: string, maxLength: number, fallback: string): string {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, maxLength);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeOptionalEventDetail(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = normalizeEventText(value, MAX_EVENT_DETAIL_LENGTH, "");
  return normalized.length > 0 ? normalized : null;
}

function makeEvent(at: string, name: string, detail?: string): DesktopRunEvent {
  return {
    at,
    name: normalizeEventText(name, MAX_EVENT_NAME_LENGTH, "unknown"),
    detail: normalizeOptionalEventDetail(detail),
  };
}

function peakMemory(
  currentPeak: DesktopMainMemorySnapshot | null,
  memory: DesktopMainMemorySnapshot,
): DesktopMainMemorySnapshot {
  if (currentPeak === null) {
    return memory;
  }
  return {
    rss: Math.max(currentPeak.rss, memory.rss),
    heapTotal: Math.max(currentPeak.heapTotal, memory.heapTotal),
    heapUsed: Math.max(currentPeak.heapUsed, memory.heapUsed),
    external: Math.max(currentPeak.external, memory.external),
    arrayBuffers: Math.max(currentPeak.arrayBuffers, memory.arrayBuffers),
  };
}

export function resolveDesktopRunMarkerPath(logDirectory: string): string {
  return Path.join(logDirectory, DESKTOP_RUN_MARKER_FILE_NAME);
}

export function readDesktopRunMarker(filePath: string): DesktopRunMarkerReadResult {
  let raw: string;
  try {
    raw = FS.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error: formatReadError(error) };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isDesktopRunMarker(parsed)) {
      return { status: "invalid", error: "Marker does not match schema version 1." };
    }
    return { status: "valid", marker: parsed };
  } catch (error) {
    return { status: "invalid", error: formatReadError(error) };
  }
}

export function classifyPreviousDesktopRun(result: DesktopRunMarkerReadResult): PreviousDesktopRun {
  if (result.status === "missing") {
    return { kind: "none" };
  }
  if (result.status === "invalid") {
    return { kind: "invalid", error: result.error };
  }
  if (result.marker.phase === "completed") {
    return { kind: "completed", marker: result.marker };
  }
  // The marker stays live until Electron's `quit` event. A SIGKILL cannot run
  // a handler, so the next launch can still distinguish its active state.
  if (result.marker.phase === "exit-requested") {
    return { kind: "interrupted-exit", marker: result.marker };
  }
  return { kind: "unclean", marker: result.marker };
}

export class DesktopExitDiagnostics {
  readonly markerPath: string;
  readonly previousRun: PreviousDesktopRun;
  #marker: DesktopRunMarker;
  readonly #now: () => string;

  constructor(options: DesktopExitDiagnosticsOptions) {
    this.markerPath = options.markerPath;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.previousRun = classifyPreviousDesktopRun(readDesktopRunMarker(options.markerPath));
    const startedAt = this.#timestamp();
    this.#marker = {
      schemaVersion: DESKTOP_RUN_MARKER_SCHEMA_VERSION,
      runId: normalizeEventText(options.runId, MAX_EVENT_DETAIL_LENGTH, "unknown"),
      startedAt,
      updatedAt: startedAt,
      pid: options.pid,
      ppid: options.ppid,
      appVersion: normalizeEventText(options.appVersion, MAX_EVENT_DETAIL_LENGTH, "unknown"),
      platform: normalizeEventText(options.platform, MAX_EVENT_NAME_LENGTH, "unknown"),
      arch: normalizeEventText(options.arch, MAX_EVENT_NAME_LENGTH, "unknown"),
      phase: "running",
      lastEvent: makeEvent(startedAt, "run-start"),
      lastFault: null,
      lastHeartbeat: null,
      peakMemory: null,
      exitIntent: null,
      completedAt: null,
      processExit: null,
    };
    this.#write(this.#marker);
  }

  get marker(): DesktopRunMarker {
    return this.#marker;
  }

  recordEvent(name: string, detail?: string): void {
    this.#replace((marker, at) => ({
      ...marker,
      updatedAt: at,
      lastEvent: makeEvent(at, name, detail),
    }));
  }

  recordFault(name: string, detail?: string): void {
    this.#replace((marker, at) => {
      const event = makeEvent(at, name, detail);
      return {
        ...marker,
        updatedAt: at,
        lastEvent: event,
        lastFault: event,
      };
    });
  }

  recordExitIntent(reason: string): void {
    this.#replace((marker, at) => {
      const normalizedReason = normalizeEventText(reason, MAX_EVENT_DETAIL_LENGTH, "unknown");
      return {
        ...marker,
        updatedAt: at,
        phase: "exit-requested",
        lastEvent: makeEvent(at, "exit-intent", normalizedReason),
        exitIntent: { at, reason: normalizedReason },
      };
    });
  }

  recordHeartbeat(input: {
    readonly uptimeSeconds: number;
    readonly memory: DesktopMainMemorySnapshot;
  }): void {
    if (!isNonNegativeFiniteNumber(input.uptimeSeconds) || !isDesktopMainMemorySnapshot(input.memory)) {
      throw new Error("Cannot record an invalid desktop main-process heartbeat.");
    }
    this.#replace((marker, at) => ({
      ...marker,
      updatedAt: at,
      lastHeartbeat: {
        at,
        uptimeSeconds: input.uptimeSeconds,
        memory: input.memory,
      },
      peakMemory: peakMemory(marker.peakMemory, input.memory),
    }));
  }

  recordProcessExit(code: number): void {
    if (!Number.isSafeInteger(code)) {
      throw new Error("Cannot record a non-integer desktop process exit code.");
    }
    this.#replace((marker, at) => ({
      ...marker,
      updatedAt: at,
      processExit: { at, code },
    }));
  }

  recordCompleted(exitCode: number): void {
    if (!Number.isSafeInteger(exitCode)) {
      throw new Error("Cannot record a non-integer completed desktop exit code.");
    }
    this.#replace((marker, at) => ({
      ...marker,
      updatedAt: at,
      phase: "completed",
      completedAt: at,
      lastEvent: makeEvent(at, "app-quit", `code=${exitCode}`),
      processExit: { at, code: exitCode },
    }));
  }

  #timestamp(): string {
    const timestamp = this.#now();
    if (!isIsoTimestamp(timestamp)) {
      throw new Error("Desktop exit diagnostics clock returned an invalid ISO timestamp.");
    }
    return timestamp;
  }

  #replace(update: (marker: DesktopRunMarker, at: string) => DesktopRunMarker): void {
    const next = update(this.#marker, this.#timestamp());
    this.#write(next);
  }

  #write(marker: DesktopRunMarker): void {
    if (!isDesktopRunMarker(marker)) {
      throw new Error("Cannot write an invalid desktop run marker.");
    }
    writePrivateTextFileAtomicallySync(this.markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    this.#marker = marker;
  }
}
