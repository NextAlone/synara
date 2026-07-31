// FILE: updateInstallMarker.ts
// Purpose: Persists and resolves durable desktop update install attempts across app restarts.
// Layer: Desktop update utility

import * as Crypto from "node:crypto";
import * as FS from "node:fs";

import type { DesktopUpdateInterruptedTurn } from "@synara/contracts";

import { writePrivateTextFileAtomicallySync } from "./atomicFile";
import { isUpdateVersionNewer } from "./updateState";
import {
  isUpdateArtifactIdentity,
  updateArtifactIdentitiesEqual,
  type UpdateArtifactIdentity,
} from "./updateArtifactIdentity";

const INSTALL_MARKER_SCHEMA_VERSION = 2;
const INSTALL_MARKER_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INTERRUPTED_TURNS = 256;

export type InstallMarkerPhase = "requested" | "handoff" | "failed" | "completed";

export interface UpdateInstallMarker {
  readonly schemaVersion: 2;
  readonly attemptId: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly requestedAt: string;
  readonly handoffAt: string | null;
  readonly phase: InstallMarkerPhase;
  readonly consecutiveFailures: number;
  readonly lastFailureAt: string | null;
  readonly artifact: UpdateArtifactIdentity;
  readonly interruptedTurns: readonly DesktopUpdateInterruptedTurn[];
}

export interface UpdateInstallHandoffExpectation {
  readonly attemptId: string;
  readonly artifact: UpdateArtifactIdentity;
}

export function installMarkerMatchesHandoffExpectation(
  marker: UpdateInstallMarker,
  expected: UpdateInstallHandoffExpectation,
): boolean {
  return (
    marker.attemptId === expected.attemptId &&
    updateArtifactIdentitiesEqual(marker.artifact, expected.artifact)
  );
}

export type InstallMarkerReadResult =
  | { readonly status: "missing" }
  | { readonly status: "valid"; readonly marker: UpdateInstallMarker }
  | { readonly status: "invalid"; readonly error: string };

export type InstallMarkerOutcome = "success" | "failure" | "already-failed" | "stale" | "invalid";

export type InstallMarkerFailureRecordResult =
  | { readonly status: "recorded" | "already-failed"; readonly marker: UpdateInstallMarker }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "mismatch" }
  | {
      readonly status: "write-failed";
      readonly marker: UpdateInstallMarker;
      readonly error: unknown;
    };

export type InstallMarkerInterruptionAcknowledgeResult =
  | {
      readonly status: "acknowledged";
      readonly remaining: readonly DesktopUpdateInterruptedTurn[];
    }
  | { readonly status: "unchanged"; readonly marker: UpdateInstallMarker }
  | { readonly status: "missing" }
  | { readonly status: "invalid"; readonly error: string }
  | { readonly status: "write-failed"; readonly error: unknown };

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isIsoTimestamp(value);
}

function isInterruptedTurn(value: unknown): value is DesktopUpdateInterruptedTurn {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const turn = value as Record<string, unknown>;
  return (
    typeof turn.threadId === "string" &&
    turn.threadId.trim().length > 0 &&
    turn.threadId.length <= 512 &&
    typeof turn.turnId === "string" &&
    turn.turnId.trim().length > 0 &&
    turn.turnId.length <= 512
  );
}

function isInterruptedTurnList(value: unknown): value is readonly DesktopUpdateInterruptedTurn[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_INTERRUPTED_TURNS &&
    value.every(isInterruptedTurn)
  );
}

export function parseDesktopUpdateInterruptedTurns(
  value: unknown,
): readonly DesktopUpdateInterruptedTurn[] | null {
  return isInterruptedTurnList(value) ? normalizeDesktopUpdateInterruptedTurns(value) : null;
}

export function normalizeDesktopUpdateInterruptedTurns(
  value: unknown,
): readonly DesktopUpdateInterruptedTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: DesktopUpdateInterruptedTurn[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isInterruptedTurn(candidate)) {
      continue;
    }
    const key = `${candidate.threadId}\0${candidate.turnId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({
      threadId: candidate.threadId,
      turnId: candidate.turnId,
    });
    if (result.length >= MAX_INTERRUPTED_TURNS) {
      break;
    }
  }
  return result;
}

function isUpdateInstallMarker(value: unknown): value is UpdateInstallMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const marker = value as Record<string, unknown>;
  return (
    marker.schemaVersion === INSTALL_MARKER_SCHEMA_VERSION &&
    typeof marker.attemptId === "string" &&
    marker.attemptId.trim().length > 0 &&
    typeof marker.fromVersion === "string" &&
    marker.fromVersion.trim().length > 0 &&
    typeof marker.toVersion === "string" &&
    marker.toVersion.trim().length > 0 &&
    isIsoTimestamp(marker.requestedAt) &&
    isNullableIsoTimestamp(marker.handoffAt) &&
    (marker.phase === "requested" ||
      marker.phase === "handoff" ||
      marker.phase === "failed" ||
      marker.phase === "completed") &&
    typeof marker.consecutiveFailures === "number" &&
    Number.isInteger(marker.consecutiveFailures) &&
    marker.consecutiveFailures >= 0 &&
    isNullableIsoTimestamp(marker.lastFailureAt) &&
    isUpdateArtifactIdentity(marker.artifact) &&
    (marker.interruptedTurns === undefined || isInterruptedTurnList(marker.interruptedTurns))
  );
}

function formatReadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createUpdateInstallMarker(args: {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly requestedAt: string;
  readonly consecutiveFailures: number;
  readonly lastFailureAt?: string | null;
  readonly artifact: UpdateArtifactIdentity;
  readonly interruptedTurns?: readonly DesktopUpdateInterruptedTurn[];
}): UpdateInstallMarker {
  return {
    schemaVersion: INSTALL_MARKER_SCHEMA_VERSION,
    attemptId: Crypto.randomUUID(),
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    requestedAt: args.requestedAt,
    handoffAt: null,
    phase: "requested",
    consecutiveFailures: args.consecutiveFailures,
    lastFailureAt: args.lastFailureAt ?? null,
    artifact: args.artifact,
    interruptedTurns: normalizeDesktopUpdateInterruptedTurns(args.interruptedTurns),
  };
}

export function readInstallMarker(filePath: string): InstallMarkerReadResult {
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
    if (!isUpdateInstallMarker(parsed)) {
      return { status: "invalid", error: "Marker does not match schema version 2." };
    }
    return {
      status: "valid",
      marker: {
        ...parsed,
        interruptedTurns: normalizeDesktopUpdateInterruptedTurns(parsed.interruptedTurns),
      },
    };
  } catch (error) {
    return { status: "invalid", error: formatReadError(error) };
  }
}

export function writeInstallMarker(filePath: string, marker: UpdateInstallMarker): void {
  if (!isUpdateInstallMarker(marker)) {
    throw new Error("Cannot write an invalid update install marker.");
  }

  writePrivateTextFileAtomicallySync(filePath, `${JSON.stringify(marker, null, 2)}\n`);
}

export function markInstallHandoffSync(
  filePath: string,
  expected: UpdateInstallHandoffExpectation,
  nowIso = new Date().toISOString(),
): UpdateInstallMarker | null {
  const result = readInstallMarker(filePath);
  if (result.status !== "valid") {
    return null;
  }
  if (
    !installMarkerMatchesHandoffExpectation(result.marker, expected) ||
    result.marker.phase === "failed"
  ) {
    return null;
  }
  if (result.marker.handoffAt !== null) {
    return result.marker.phase === "handoff" ? result.marker : null;
  }
  const marker: UpdateInstallMarker = {
    ...result.marker,
    phase: "handoff",
    handoffAt: nowIso,
  };
  writeInstallMarker(filePath, marker);
  return marker;
}

export function recordInstallMarkerFailureSync(
  filePath: string,
  expected: UpdateInstallHandoffExpectation,
  nowIso: string,
): InstallMarkerFailureRecordResult {
  const result = readInstallMarker(filePath);
  if (result.status !== "valid") {
    return result;
  }
  if (!installMarkerMatchesHandoffExpectation(result.marker, expected)) {
    return { status: "mismatch" };
  }
  if (result.marker.phase === "completed") {
    return { status: "mismatch" };
  }
  if (result.marker.phase === "failed") {
    return { status: "already-failed", marker: result.marker };
  }

  const marker: UpdateInstallMarker = {
    ...result.marker,
    phase: "failed",
    consecutiveFailures: result.marker.consecutiveFailures + 1,
    lastFailureAt: nowIso,
  };
  try {
    writeInstallMarker(filePath, marker);
    return { status: "recorded", marker };
  } catch (error) {
    return { status: "write-failed", marker, error };
  }
}

export function acknowledgeInstallInterruptedTurnSync(
  filePath: string,
  acknowledged: DesktopUpdateInterruptedTurn,
): InstallMarkerInterruptionAcknowledgeResult {
  const result = readInstallMarker(filePath);
  if (result.status !== "valid") {
    return result;
  }
  const remaining = result.marker.interruptedTurns.filter(
    (turn) =>
      turn.threadId !== acknowledged.threadId || turn.turnId !== acknowledged.turnId,
  );
  if (remaining.length === result.marker.interruptedTurns.length) {
    return { status: "unchanged", marker: result.marker };
  }
  try {
    if (remaining.length === 0) {
      clearInstallMarker(filePath);
    } else {
      writeInstallMarker(filePath, {
        ...result.marker,
        phase: "completed",
        interruptedTurns: remaining,
      });
    }
    return { status: "acknowledged", remaining };
  } catch (error) {
    return { status: "write-failed", error };
  }
}

export function resolveInstallMarkerOutcome(
  marker: unknown,
  currentVersion: string,
  nowIso: string,
): InstallMarkerOutcome {
  if (!isUpdateInstallMarker(marker) || !isIsoTimestamp(nowIso)) {
    return "invalid";
  }
  if (!isUpdateVersionNewer(currentVersion, marker.toVersion)) {
    return "success";
  }
  if (Date.parse(nowIso) - Date.parse(marker.requestedAt) > INSTALL_MARKER_STALE_AFTER_MS) {
    return "stale";
  }
  if (marker.phase === "failed") {
    return "already-failed";
  }
  return "failure";
}

export function clearInstallMarker(filePath: string): void {
  FS.rmSync(filePath, { force: true });
}
