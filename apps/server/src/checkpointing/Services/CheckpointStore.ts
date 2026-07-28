/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref and catalog-backed JJ checkpoint capture/restore plus diff
 * computation for a workspace thread timeline. It does not store user-facing
 * orchestration checkpoint metadata or coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef, type VcsBackend } from "@synara/contracts";

export interface CheckpointWorkspaceInput {
  readonly cwd: string;
  readonly backend: VcsBackend;
  /**
   * Allows one `jj workspace update-stale` recovery before retrying a
   * working-copy snapshot. Set only for Synara-managed workspaces.
   */
  readonly recoverStaleWorkingCopy?: boolean;
}

export interface CaptureCheckpointInput extends CheckpointWorkspaceInput {
  readonly checkpointRef: CheckpointRef;
  /**
   * Treat an already-existing ref as success and skip the capture.
   *
   * Used for pre-turn baseline refs where the first snapshot must win:
   * overwriting an existing baseline with a later capture would record a
   * working tree the agent may already have modified.
   */
  readonly skipIfExists?: boolean;
}

export interface CopyCheckpointRefInput extends CheckpointWorkspaceInput {
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput extends CheckpointWorkspaceInput {
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput extends CheckpointWorkspaceInput {
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly maxOutputBytes?: number;
}

export interface DiffCheckpointToWorkingCopyInput extends CheckpointWorkspaceInput {
  readonly fromCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly maxOutputBytes?: number;
}

export interface ReverseCheckpointDiffInput extends CheckpointWorkspaceInput {
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly maxOutputBytes?: number;
}

export interface DeleteCheckpointRefsInput extends CheckpointWorkspaceInput {
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd belongs to the explicitly selected backend.
   */
  readonly isRepository: (
    input: CheckpointWorkspaceInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Capture workspace state and bind it to the provided logical checkpoint ref.
   *
   * Git writes a hidden ref; JJ reuses one physical snapshot per unique tree.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Bind an existing checkpoint snapshot to another logical ref.
   *
   * Used to bind a pre-send message snapshot to the provider turn id once known.
   */
  readonly copyCheckpointRef: (
    input: CopyCheckpointRefInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Compute a patch from a durable checkpoint to the current working copy
   * without creating a temporary checkpoint ref.
   */
  readonly diffCheckpointToWorkingCopy: (
    input: DiffCheckpointToWorkingCopyInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Reverse only the changes between two checkpoints onto the current workspace.
   */
  readonly reverseCheckpointDiff: (
    input: ReverseCheckpointDiffInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Missing refs are tolerated (deleting an absent ref is a no-op for Git), but
   * a ref that exists and could not be deleted fails the effect: callers use
   * this to protect snapshots that are a user's only way back.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "synara/checkpointing/Services/CheckpointStore",
) {}
