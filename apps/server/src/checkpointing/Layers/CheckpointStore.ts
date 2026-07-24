/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements backend-native checkpoint capture/restore. Git uses hidden refs;
 * JJ uses Synara-owned local bookmarks that anchor immutable snapshot revisions.
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Cause, Deferred, Effect, Exit, Layer, FileSystem, Option, Path, Semaphore } from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { JjCore } from "../../vcs/Services/JjCore.ts";
import {
  exactJjBookmarkRevset,
  jjCheckpointBookmark,
} from "../../vcs/checkpointBookmarks.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const jj = yield* JjCore;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();

  // Normalize the cwd so captures for the same repo reached via differently
  // written paths (trailing slash, relative segments) share one in-flight slot.
  const captureKey = (input: {
    readonly cwd: string;
    readonly backend: "git" | "jj";
    readonly checkpointRef: CheckpointRef;
  }) => `${input.backend}\0${path.resolve(input.cwd)}\0${input.checkpointRef}`;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository = (cwd: string) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const isJjRepository = (cwd: string) =>
    jj.detectRepository(cwd).pipe(
      Effect.map((repository) => repository !== null),
      Effect.catch(() => Effect.succeed(false)),
    );

  const isRepository: CheckpointStoreShape["isRepository"] = (input) =>
    input.backend === "git" ? isGitRepository(input.cwd) : isJjRepository(input.cwd);

  const resolveJjCheckpointRevision = (cwd: string, checkpointRef: CheckpointRef) => {
    const bookmark = jjCheckpointBookmark(checkpointRef);
    return jj
      .execute({
        operation: "CheckpointStore.resolveJjCheckpointRevision",
        cwd,
        args: [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          exactJjBookmarkRevset(bookmark),
          "-n",
          "1",
          "-T",
          'commit_id ++ "\\n"',
        ],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) return null;
          const revision = result.stdout.trim();
          return revision.length > 0 ? revision : null;
        }),
      );
  };

  const captureGitCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";

      // Checked inside the single-flight owner (see captureCheckpoint) so the
      // existence probe and the capture cannot interleave with another capture
      // for the same (cwd, checkpointRef).
      if (input.skipIfExists) {
        const existingCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (existingCommit !== null) {
          return;
        }
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "Synara",
              GIT_AUTHOR_EMAIL: "synara@users.noreply.github.com",
              GIT_COMMITTER_NAME: "Synara",
              GIT_COMMITTER_EMAIL: "synara@users.noreply.github.com",
            };

            const headExists = yield* hasHeadCommit(input.cwd);
            if (headExists) {
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `Synara checkpoint ref=${input.checkpointRef}`;
            const commitTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const captureJjCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        if (input.skipIfExists) {
          const existingRevision = yield* resolveJjCheckpointRevision(
            input.cwd,
            input.checkpointRef,
          );
          if (existingRevision !== null) return;
        }

        // Snapshot the filesystem into @, then duplicate that revision for the
        // checkpoint. A bookmark attached directly to @ would follow later
        // rewrites; advancing @ with `jj new` would instead make normal working
        // copy changes disappear from status/commit flows.
        yield* jj.execute({
          operation: "CheckpointStore.captureCheckpoint.jjSnapshot",
          cwd: input.cwd,
          args: ["status"],
        });
        const snapshotToken = randomUUID();
        const snapshotDescription = `synara checkpoint snapshot ${snapshotToken}`;
        const duplicateDescriptionTemplate = JSON.stringify(snapshotDescription);
        yield* jj.execute({
          operation: "CheckpointStore.captureCheckpoint.jjDuplicate",
          cwd: input.cwd,
          args: [
            "--config",
            `templates.duplicate_description=${JSON.stringify(duplicateDescriptionTemplate)}`,
            "duplicate",
            "@",
          ],
        });
        const snapshot = yield* jj.readRevisionIdentity(
          input.cwd,
          `description(substring:${JSON.stringify(snapshotToken)})`,
        );
        yield* jj.execute({
          operation: "CheckpointStore.captureCheckpoint.jjAnchor",
          cwd: input.cwd,
          args: [
            "bookmark",
            "set",
            "--allow-backwards",
            "--revision",
            snapshot.commitId,
            jjCheckpointBookmark(input.checkpointRef),
          ],
        }).pipe(
          Effect.onError(() =>
            jj
              .execute({
                operation: "CheckpointStore.captureCheckpoint.jjCleanup",
                cwd: input.cwd,
                args: ["--ignore-working-copy", "abandon", snapshot.commitId],
              })
              .pipe(Effect.ignore),
          ),
        );
      }),
    );

  const captureCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    input.backend === "git"
      ? captureGitCheckpointOnce(input)
      : captureJjCheckpointOnce(input);

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const key = captureKey(input);
      const registration = yield* captureLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = inFlightCaptures.get(key);
          if (existing) {
            return { owner: false as const, deferred: existing };
          }
          const deferred = yield* Deferred.make<void, CheckpointStoreError>();
          inFlightCaptures.set(key, deferred);
          return { owner: true as const, deferred };
        }),
      );

      if (!registration.owner) {
        return yield* Deferred.await(registration.deferred);
      }

      // Let the git capture remain interruptible, but always notify waiters
      // and clear the shared in-flight slot before this owner fiber exits.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              captureCheckpointOnce(input).pipe(
                Effect.timeoutOption(CHECKPOINT_CAPTURE_TIMEOUT_MS),
                Effect.flatMap((completed) =>
                  Option.isSome(completed)
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.captureCheckpoint",
                          detail: `Checkpoint capture timed out after ${CHECKPOINT_CAPTURE_TIMEOUT_MS}ms.`,
                        }),
                      ),
                ),
              ),
            ),
          );
          // Waiters joined an in-flight capture they do not control; replaying the
          // owner's raw interrupt cause would make callers treat it as their own
          // fiber being interrupted. Surface a typed error instead.
          const waiterExit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Checkpoint capture was interrupted before completion.",
                  }),
                )
              : exit;
          yield* Deferred.done(registration.deferred, waiterExit);
          yield* captureLock.withPermits(1)(Effect.sync(() => inFlightCaptures.delete(key)));
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
        }),
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    (input.backend === "git"
      ? resolveCheckpointCommit(input.cwd, input.checkpointRef)
      : resolveJjCheckpointRevision(input.cwd, input.checkpointRef)
    ).pipe(Effect.map((revision) => revision !== null));

  const copyGitCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.copyCheckpointRef";
      const commitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", input.toCheckpointRef, commitOid],
      });
      return true;
    });

  const copyJjCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        const revision = yield* resolveJjCheckpointRevision(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (!revision) return false;
        yield* jj.execute({
          operation: "CheckpointStore.copyCheckpointRef.jj",
          cwd: input.cwd,
          args: [
            "bookmark",
            "set",
            "--allow-backwards",
            "--revision",
            revision,
            jjCheckpointBookmark(input.toCheckpointRef),
          ],
        });
        return true;
      }),
    );

  const copyCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    input.backend === "git" ? copyGitCheckpointRef(input) : copyJjCheckpointRef(input);

  const restoreGitCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";

      let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

      if (!commitOid && input.fallbackToHead === true) {
        commitOid = yield* resolveHeadCommit(input.cwd);
      }

      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["reset", "--quiet", "--", "."],
        });
      }

      return true;
    });

  const restoreJjCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        const checkpointRevision = yield* resolveJjCheckpointRevision(
          input.cwd,
          input.checkpointRef,
        );
        const revision =
          checkpointRevision ?? (input.fallbackToHead === true ? "@-" : null);
        if (!revision) return false;
        yield* jj.execute({
          operation: "CheckpointStore.restoreCheckpoint.jj",
          cwd: input.cwd,
          args: ["restore", "--from", revision, "--into", "@", "--", "."],
        });
        return true;
      }),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    input.backend === "git" ? restoreGitCheckpoint(input) : restoreJjCheckpoint(input);

  const diffGitCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      let [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

  const diffJjCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      let [fromRevision, toRevision] = yield* Effect.all(
        [
          resolveJjCheckpointRevision(input.cwd, input.fromCheckpointRef),
          resolveJjCheckpointRevision(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );
      if (!fromRevision && input.fallbackFromToHead === true) {
        fromRevision = "@-";
      }
      if (!fromRevision || !toRevision) {
        return yield* new CheckpointInvariantError({
          operation: "CheckpointStore.diffCheckpoints.jj",
          detail: "Checkpoint bookmark is unavailable for diff operation.",
        });
      }
      const result = yield* jj.execute({
        operation: "CheckpointStore.diffCheckpoints.jj",
        cwd: input.cwd,
        args: [
          "--ignore-working-copy",
          "diff",
          "--from",
          fromRevision,
          "--to",
          toRevision,
          "--git",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          "--",
          ".",
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      return result.stdout;
    });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    input.backend === "git" ? diffGitCheckpoints(input) : diffJjCheckpoints(input);

  const reverseGitCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid || !toCommitOid) {
        return false;
      }

      const diff = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--binary",
          "--full-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      if (diff.stdout.length === 0) {
        return true;
      }

      const changedPaths = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "--no-renames", "-z", fromCommitOid, toCommitOid],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      const affectedPaths = changedPaths.stdout.split("\0").filter((entry) => entry.length > 0);

      return yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "synara-checkpoint-undo-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const patchPath = path.join(tempDir, "turn.patch");
            yield* fs.writeFileString(patchPath, diff.stdout);
            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["apply", "--reverse", "--whitespace=nowarn", "--", patchPath],
            });
            if (affectedPaths.length > 0) {
              const resetExit = yield* Effect.exit(
                git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["reset", "--quiet", fromCommitOid, "--", ...affectedPaths],
                }),
              );
              if (Exit.isFailure(resetExit)) {
                yield* git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["apply", "--whitespace=nowarn", "--", patchPath],
                });
                return yield* Effect.failCause(resetExit.cause);
              }
            }
            return true;
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation,
              detail: "Failed to prepare the checkpoint patch for undo.",
              cause: error,
            }),
          ),
        ),
      );
    });

  const reverseJjCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        const [fromRevision, toRevision] = yield* Effect.all(
          [
            resolveJjCheckpointRevision(input.cwd, input.fromCheckpointRef),
            resolveJjCheckpointRevision(input.cwd, input.toCheckpointRef),
          ],
          { concurrency: "unbounded" },
        );
        if (!fromRevision || !toRevision) return false;

        const turnDiff = yield* jj.readRangeDiff(
          input.cwd,
          fromRevision,
          toRevision,
        );
        const affectedPaths = [
          ...new Set(
            turnDiff.files.flatMap((file) => [
              file.sourcePath,
              file.targetPath,
            ]),
          ),
        ];
        if (affectedPaths.length === 0) return true;

        // Restoring exact checkpoint content is native and handles binary files,
        // but it would overwrite newer edits in the same paths. Refuse that
        // case instead of silently discarding post-checkpoint work.
        const currentDelta = yield* jj.execute({
          operation: "CheckpointStore.reverseCheckpointDiff.jjVerifyCurrent",
          cwd: input.cwd,
          args: [
            "--ignore-working-copy",
            "diff",
            "--from",
            toRevision,
            "--to",
            "@",
            "--summary",
            "--",
            ...affectedPaths,
          ],
          maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });
        if (currentDelta.stdout.trim().length > 0) {
          return yield* new CheckpointInvariantError({
            operation: "CheckpointStore.reverseCheckpointDiff.jj",
            detail:
              "The workspace changed again in files touched by this turn; refusing to overwrite newer JJ changes.",
          });
        }

        yield* jj.execute({
          operation: "CheckpointStore.reverseCheckpointDiff.jj",
          cwd: input.cwd,
          args: [
            "restore",
            "--from",
            fromRevision,
            "--into",
            "@",
            "--",
            ...affectedPaths,
          ],
        });
        return true;
      }),
    );

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    input.backend === "git"
      ? reverseGitCheckpointDiff(input)
      : reverseJjCheckpointDiff(input);

  const deleteGitCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      // Ref deletion writes contend on packed-refs.lock; concurrent deletes
      // lose the lock race and allowNonZeroExit would swallow the failure.
      yield* Effect.forEach(
        input.checkpointRefs,
        (checkpointRef) =>
          git.execute({
            operation,
            cwd: input.cwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          }),
        { discard: true },
      );
    });

  const deleteJjCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        const resolved = yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            resolveJjCheckpointRevision(input.cwd, checkpointRef).pipe(
              Effect.map((revision) =>
                revision === null ? null : { checkpointRef, revision },
              ),
            ),
          { concurrency: 4 },
        );
        const existing = resolved.filter(
          (
            entry,
          ): entry is {
            readonly checkpointRef: CheckpointRef;
            readonly revision: string;
          } => entry !== null,
        );
        if (existing.length === 0) return;
        yield* jj.execute({
          operation: "CheckpointStore.deleteCheckpointRefs.jj",
          cwd: input.cwd,
          args: [
            "--ignore-working-copy",
            "bookmark",
            "delete",
            ...existing.map((entry) => jjCheckpointBookmark(entry.checkpointRef)),
          ],
        });
        yield* Effect.forEach(
          [...new Set(existing.map((entry) => entry.revision))],
          (revision) =>
            jj
              .execute({
                operation: "CheckpointStore.deleteCheckpointRefs.jjRemainingBookmarks",
                cwd: input.cwd,
                args: [
                  "--ignore-working-copy",
                  "bookmark",
                  "list",
                  "-r",
                  revision,
                  "-T",
                  'name ++ "\n"',
                ],
              })
              .pipe(
                Effect.flatMap((remaining) =>
                  remaining.stdout.trim().length > 0
                    ? Effect.void
                    : jj
                        .execute({
                          operation: "CheckpointStore.deleteCheckpointRefs.jjAbandon",
                          cwd: input.cwd,
                          args: ["--ignore-working-copy", "abandon", revision],
                        })
                        .pipe(Effect.asVoid),
                ),
                Effect.catch((error) =>
                  Effect.logWarning(
                    "checkpoint cleanup left an unreferenced JJ snapshot",
                    {
                      cwd: input.cwd,
                      revision,
                      error: error instanceof Error ? error.message : String(error),
                    },
                  ),
                ),
              ),
          { discard: true, concurrency: 1 },
        );
      }),
    );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    input.backend === "git"
      ? deleteGitCheckpointRefs(input)
      : deleteJjCheckpointRefs(input);

  return {
    isRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
