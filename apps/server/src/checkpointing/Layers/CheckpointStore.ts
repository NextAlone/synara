/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements backend-native checkpoint capture/restore. Git uses hidden refs;
 * JJ uses Synara-owned local bookmarks that anchor immutable snapshot revisions.
 *
 * This layer owns filesystem/VCS interactions and the physical JJ snapshot
 * catalog. It does not persist orchestration checkpoint rows or coordinate
 * provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { createHash, randomUUID } from "node:crypto";

import { Cause, Deferred, Effect, Exit, Layer, FileSystem, Option, Path, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { JjCore } from "../../vcs/Services/JjCore.ts";
import {
  exactJjBookmarkRevset,
  jjCheckpointBookmark,
  SYNARA_JJ_SNAPSHOT_BOOKMARK_PREFIX,
} from "../../vcs/checkpointBookmarks.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";
import { parseManagedCheckpointRef } from "../Utils.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

interface CheckpointSnapshotRow {
  readonly snapshotId: string;
  readonly revisionId: string | null;
  readonly treeId: string;
  readonly anchorRef: string;
  readonly status: "creating" | "ready" | "missing" | "error";
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const jj = yield* JjCore;
  const sql = yield* SqlClient.SqlClient;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();
  const jjRepositoryKeys = new Map<string, string>();
  let jjTreeIdTemplateSupported: boolean | null = null;

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

  const snapshotRepositoryKey = (cwd: string) => {
    const workspaceKey = path.resolve(cwd);
    return jjRepositoryKeys.get(workspaceKey) ?? workspaceKey;
  };

  const rememberJjRepositoryKey = (cwd: string) => {
    const workspaceKey = path.resolve(cwd);
    if (jjRepositoryKeys.has(workspaceKey)) return Effect.void;
    return jj.detectRepository(cwd).pipe(
      Effect.tap((repository) =>
        Effect.sync(() => {
          if (repository) {
            jjRepositoryKeys.set(workspaceKey, repository.repositoryStorePath);
          }
        }),
      ),
      Effect.asVoid,
    );
  };

  const isJjRepository = (cwd: string) =>
    jj.detectRepository(cwd).pipe(
      Effect.map((repository) => {
        if (!repository) return false;
        jjRepositoryKeys.set(path.resolve(cwd), repository.repositoryStorePath);
        return true;
      }),
      Effect.catch(() => Effect.succeed(false)),
    );

  const isRepository: CheckpointStoreShape["isRepository"] = (input) =>
    input.backend === "git" ? isGitRepository(input.cwd) : isJjRepository(input.cwd);

  const resolveLegacyJjCheckpointRevision = (cwd: string, checkpointRef: CheckpointRef) => {
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

  const snapshotBookmark = (snapshotId: string) =>
    `${SYNARA_JJ_SNAPSHOT_BOOKMARK_PREFIX}${snapshotId}`;
  const aliasMetadata = (checkpointRef: CheckpointRef) => {
    const parsed = parseManagedCheckpointRef(checkpointRef);
    return parsed
      ? { aliasKind: parsed.kind, aliasKey: parsed.valueToken }
      : { aliasKind: "legacy", aliasKey: checkpointRef };
  };
  const mapCatalogError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CheckpointInvariantError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointInvariantError({
              operation,
              detail: "Checkpoint snapshot catalog operation failed.",
              cause,
            }),
        ),
      );

  const findSnapshotByAlias = (cwd: string, checkpointRef: CheckpointRef) =>
    sql<CheckpointSnapshotRow>`
      SELECT
        snapshots.snapshot_id AS "snapshotId",
        snapshots.revision_id AS "revisionId",
        snapshots.tree_id AS "treeId",
        snapshots.anchor_ref AS "anchorRef",
        snapshots.status AS "status"
      FROM checkpoint_snapshot_aliases AS aliases
      INNER JOIN checkpoint_snapshots AS snapshots
        ON snapshots.snapshot_id = aliases.snapshot_id
      WHERE aliases.repository_key = ${snapshotRepositoryKey(cwd)}
        AND aliases.checkpoint_ref = ${checkpointRef}
        AND snapshots.backend = 'jj'
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      mapCatalogError("CheckpointStore.findSnapshotByAlias"),
    );

  const findSnapshotByTree = (cwd: string, treeId: string) =>
    sql<CheckpointSnapshotRow>`
      SELECT
        snapshot_id AS "snapshotId",
        revision_id AS "revisionId",
        tree_id AS "treeId",
        anchor_ref AS "anchorRef",
        status
      FROM checkpoint_snapshots
      WHERE backend = 'jj'
        AND repository_key = ${snapshotRepositoryKey(cwd)}
        AND tree_id = ${treeId}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows[0] ?? null),
      mapCatalogError("CheckpointStore.findSnapshotByTree"),
    );

  const recordCreatingSnapshot = (cwd: string, treeId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<CheckpointSnapshotRow>`
          SELECT
            snapshot_id AS "snapshotId",
            revision_id AS "revisionId",
            tree_id AS "treeId",
            anchor_ref AS "anchorRef",
            status
          FROM checkpoint_snapshots
          WHERE backend = 'jj'
            AND repository_key = ${snapshotRepositoryKey(cwd)}
            AND tree_id = ${treeId}
          LIMIT 1
        `;
        const snapshotId = existing[0]?.snapshotId ?? randomUUID();
        const anchorRef = snapshotBookmark(snapshotId);
        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO checkpoint_snapshots (
            snapshot_id,
            backend,
            repository_key,
            revision_id,
            tree_id,
            anchor_ref,
            status,
            created_at,
            last_verified_at
          ) VALUES (
            ${snapshotId},
            'jj',
            ${snapshotRepositoryKey(cwd)},
            NULL,
            ${treeId},
            ${anchorRef},
            'creating',
            ${now},
            NULL
          )
          ON CONFLICT (backend, repository_key, tree_id) DO UPDATE SET
            revision_id = NULL,
            anchor_ref = excluded.anchor_ref,
            status = 'creating',
            last_verified_at = NULL
        `;
        return {
          snapshotId,
          revisionId: null,
          treeId,
          anchorRef,
          status: "creating" as const,
        };
      }),
    ).pipe(mapCatalogError("CheckpointStore.recordCreatingSnapshot"));

  const finalizeSnapshot = (input: {
    readonly cwd: string;
    readonly snapshotId: string;
    readonly revisionId: string;
    readonly status: "ready" | "missing" | "error";
  }) =>
    sql`
      UPDATE checkpoint_snapshots
      SET
        revision_id = ${input.revisionId},
        status = ${input.status},
        last_verified_at = ${new Date().toISOString()}
      WHERE snapshot_id = ${input.snapshotId}
        AND repository_key = ${snapshotRepositoryKey(input.cwd)}
    `.pipe(
      Effect.asVoid,
      mapCatalogError("CheckpointStore.finalizeSnapshot"),
    );

  const recordCreatingSnapshotRevision = (input: {
    readonly cwd: string;
    readonly snapshotId: string;
    readonly revisionId: string;
  }) =>
    sql`
      UPDATE checkpoint_snapshots
      SET revision_id = ${input.revisionId}, status = 'creating'
      WHERE snapshot_id = ${input.snapshotId}
        AND repository_key = ${snapshotRepositoryKey(input.cwd)}
    `.pipe(
      Effect.asVoid,
      mapCatalogError("CheckpointStore.recordCreatingSnapshotRevision"),
    );

  const markSnapshotStatus = (
    cwd: string,
    snapshotId: string,
    status: "missing" | "error",
  ) =>
    sql`
      UPDATE checkpoint_snapshots
      SET status = ${status}, last_verified_at = ${new Date().toISOString()}
      WHERE snapshot_id = ${snapshotId}
        AND repository_key = ${snapshotRepositoryKey(cwd)}
    `.pipe(
      Effect.asVoid,
      mapCatalogError("CheckpointStore.markSnapshotStatus"),
    );

  const bindSnapshotAlias = (
    cwd: string,
    checkpointRef: CheckpointRef,
    snapshotId: string,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const repositoryKey = snapshotRepositoryKey(cwd);
        const previous = yield* sql<{ readonly snapshotId: string }>`
          SELECT snapshot_id AS "snapshotId"
          FROM checkpoint_snapshot_aliases
          WHERE repository_key = ${repositoryKey}
            AND checkpoint_ref = ${checkpointRef}
          LIMIT 1
        `;
        const metadata = aliasMetadata(checkpointRef);
        yield* sql`
          INSERT INTO checkpoint_snapshot_aliases (
            repository_key,
            checkpoint_ref,
            snapshot_id,
            alias_kind,
            alias_key,
            created_at
          ) VALUES (
            ${repositoryKey},
            ${checkpointRef},
            ${snapshotId},
            ${metadata.aliasKind},
            ${metadata.aliasKey},
            ${new Date().toISOString()}
          )
          ON CONFLICT (repository_key, checkpoint_ref) DO UPDATE SET
            snapshot_id = excluded.snapshot_id,
            alias_kind = excluded.alias_kind,
            alias_key = excluded.alias_key,
            created_at = excluded.created_at
        `;
        const previousSnapshotId = previous[0]?.snapshotId;
        if (!previousSnapshotId || previousSnapshotId === snapshotId) {
          return null;
        }
        const remaining = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM checkpoint_snapshot_aliases
          WHERE snapshot_id = ${previousSnapshotId}
        `;
        if ((remaining[0]?.count ?? 0) > 0) {
          return null;
        }
        const orphaned = yield* sql<CheckpointSnapshotRow>`
          SELECT
            snapshot_id AS "snapshotId",
            revision_id AS "revisionId",
            tree_id AS "treeId",
            anchor_ref AS "anchorRef",
            status
          FROM checkpoint_snapshots
          WHERE snapshot_id = ${previousSnapshotId}
          LIMIT 1
        `;
        return orphaned[0] ?? null;
      }),
    ).pipe(mapCatalogError("CheckpointStore.bindSnapshotAlias"));

  const deleteSnapshotAliases = (cwd: string, checkpointRefs: ReadonlyArray<CheckpointRef>) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if (checkpointRefs.length === 0) return [] as CheckpointSnapshotRow[];
        const repositoryKey = snapshotRepositoryKey(cwd);
        const aliasedSnapshotIds = yield* Effect.forEach(
          checkpointRefs,
          (checkpointRef) =>
            sql<{ readonly snapshotId: string }>`
              SELECT snapshot_id AS "snapshotId"
              FROM checkpoint_snapshot_aliases
              WHERE repository_key = ${repositoryKey}
                AND checkpoint_ref = ${checkpointRef}
              LIMIT 1
            `.pipe(Effect.map((rows) => rows[0]?.snapshotId ?? null)),
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          checkpointRefs,
          (checkpointRef) =>
            sql`
              DELETE FROM checkpoint_snapshot_aliases
              WHERE repository_key = ${repositoryKey}
                AND checkpoint_ref = ${checkpointRef}
            `,
          { discard: true, concurrency: 1 },
        );
        const orphaned: CheckpointSnapshotRow[] = [];
        for (const snapshotId of new Set(
          aliasedSnapshotIds.filter((id): id is string => id !== null),
        )) {
          const remaining = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM checkpoint_snapshot_aliases
            WHERE snapshot_id = ${snapshotId}
          `;
          if ((remaining[0]?.count ?? 0) > 0) continue;
          const rows = yield* sql<CheckpointSnapshotRow>`
            SELECT
              snapshot_id AS "snapshotId",
              revision_id AS "revisionId",
              tree_id AS "treeId",
              anchor_ref AS "anchorRef",
              status
            FROM checkpoint_snapshots
            WHERE snapshot_id = ${snapshotId}
            LIMIT 1
          `;
          if (rows[0]) orphaned.push(rows[0]);
        }
        return orphaned;
      }),
    ).pipe(mapCatalogError("CheckpointStore.deleteSnapshotAliases"));

  const findUnaliasedSnapshots = (cwd: string) =>
    sql<CheckpointSnapshotRow>`
      SELECT
        snapshots.snapshot_id AS "snapshotId",
        snapshots.revision_id AS "revisionId",
        snapshots.tree_id AS "treeId",
        snapshots.anchor_ref AS "anchorRef",
        snapshots.status
      FROM checkpoint_snapshots AS snapshots
      LEFT JOIN checkpoint_snapshot_aliases AS aliases
        ON aliases.snapshot_id = snapshots.snapshot_id
      WHERE snapshots.backend = 'jj'
        AND snapshots.repository_key = ${snapshotRepositoryKey(cwd)}
        AND aliases.snapshot_id IS NULL
    `.pipe(mapCatalogError("CheckpointStore.findUnaliasedSnapshots"));

  const resolveJjBookmarkRevision = (cwd: string, bookmark: string) =>
    jj
      .execute({
        operation: "CheckpointStore.resolveJjSnapshotRevision",
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

  const verifyJjSnapshot = (cwd: string, snapshot: CheckpointSnapshotRow) =>
    Effect.gen(function* () {
      if (snapshot.status !== "ready" || !snapshot.revisionId) return false;
      const anchoredRevision = yield* resolveJjBookmarkRevision(cwd, snapshot.anchorRef);
      if (anchoredRevision === snapshot.revisionId) return true;
      yield* markSnapshotStatus(cwd, snapshot.snapshotId, "missing");
      return false;
    });

  const resolveJjCheckpointRevision = (cwd: string, checkpointRef: CheckpointRef) =>
    Effect.gen(function* () {
      const snapshot = yield* findSnapshotByAlias(cwd, checkpointRef);
      if (snapshot && (yield* verifyJjSnapshot(cwd, snapshot))) {
        return snapshot.revisionId;
      }
      return yield* resolveLegacyJjCheckpointRevision(cwd, checkpointRef);
    });

  const readJjTreeId = (cwd: string, revision: string) =>
    Effect.gen(function* () {
      // JJ 0.43 does not expose `tree_id` to log templates. Prefer the public
      // template when available and use the debug object representation only
      // as a compatibility fallback.
      if (jjTreeIdTemplateSupported !== false) {
        const templateResult = yield* jj.execute({
          operation: "CheckpointStore.readJjTreeId",
          cwd,
          args: [
            "--ignore-working-copy",
            "log",
            "--no-graph",
            "-r",
            revision,
            "-n",
            "1",
            "-T",
            'tree_id ++ "\\n"',
          ],
          allowNonZeroExit: true,
        });
        if (templateResult.code === 0) {
          const treeId = templateResult.stdout.trim();
          if (treeId.length > 0) {
            jjTreeIdTemplateSupported = true;
            return treeId;
          }
        }
        jjTreeIdTemplateSupported = false;
      }

      const identity = yield* jj.readRevisionIdentity(cwd, revision);
      const debugResult = yield* jj.execute({
        operation: "CheckpointStore.readJjTreeId.compat",
        cwd,
        args: [
          "--ignore-working-copy",
          "debug",
          "object",
          "commit",
          identity.commitId,
        ],
      });
      const resolvedTreeId = debugResult.stdout.match(
        /root_tree:\s*Resolved\(\s*TreeId\(\s*"([0-9a-f]+)"/s,
      )?.[1];
      if (resolvedTreeId) return resolvedTreeId;

      // Conflicted commits can carry a merged root tree instead of one TreeId.
      // Hash just that canonical debug block so equivalent merged trees still
      // deduplicate without retaining the full command output in SQLite.
      const rootTree = debugResult.stdout.match(
        /root_tree:\s*([\s\S]*?)\n\s*conflict_labels:/,
      )?.[1];
      if (rootTree) {
        return `merged:${createHash("sha256").update(rootTree).digest("hex")}`;
      }

      return yield* new CheckpointInvariantError({
        operation: "CheckpointStore.readJjTreeId",
        detail: "JJ returned no readable root tree identity.",
      });
    });

  const recordReadySnapshot = (input: {
    readonly cwd: string;
    readonly treeId: string;
    readonly revisionId: string;
    readonly anchorRef: string;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* sql<CheckpointSnapshotRow>`
          SELECT
            snapshot_id AS "snapshotId",
            revision_id AS "revisionId",
            tree_id AS "treeId",
            anchor_ref AS "anchorRef",
            status
          FROM checkpoint_snapshots
          WHERE backend = 'jj'
            AND repository_key = ${snapshotRepositoryKey(input.cwd)}
            AND tree_id = ${input.treeId}
          LIMIT 1
        `;
        const snapshotId = existing[0]?.snapshotId ?? randomUUID();
        yield* sql`
          INSERT INTO checkpoint_snapshots (
            snapshot_id,
            backend,
            repository_key,
            revision_id,
            tree_id,
            anchor_ref,
            status,
            created_at,
            last_verified_at
          ) VALUES (
            ${snapshotId},
            'jj',
            ${snapshotRepositoryKey(input.cwd)},
            ${input.revisionId},
            ${input.treeId},
            ${input.anchorRef},
            'ready',
            ${new Date().toISOString()},
            ${new Date().toISOString()}
          )
          ON CONFLICT (backend, repository_key, tree_id) DO UPDATE SET
            revision_id = excluded.revision_id,
            anchor_ref = excluded.anchor_ref,
            status = 'ready',
            last_verified_at = excluded.last_verified_at
        `;
        return {
          snapshotId,
          revisionId: input.revisionId,
          treeId: input.treeId,
          anchorRef: input.anchorRef,
          status: "ready" as const,
        };
      }),
    ).pipe(mapCatalogError("CheckpointStore.recordReadySnapshot"));

  const cleanupJjSnapshotRows = (
    cwd: string,
    snapshots: ReadonlyArray<CheckpointSnapshotRow | null>,
  ) =>
    Effect.forEach(
      [
        ...new Map(
          snapshots
            .filter((snapshot): snapshot is CheckpointSnapshotRow => snapshot !== null)
            .map((snapshot) => [snapshot.snapshotId, snapshot]),
        ).values(),
      ],
      (snapshot) =>
        Effect.gen(function* () {
          const aliases = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count
            FROM checkpoint_snapshot_aliases
            WHERE snapshot_id = ${snapshot.snapshotId}
          `.pipe(mapCatalogError("CheckpointStore.cleanupJjSnapshotRows.countAliases"));
          if ((aliases[0]?.count ?? 0) > 0) return;

          yield* jj
            .execute({
              operation: "CheckpointStore.cleanupJjSnapshotBookmark",
              cwd,
              args: ["--ignore-working-copy", "bookmark", "delete", snapshot.anchorRef],
            })
            .pipe(Effect.asVoid);
          if (snapshot.revisionId) {
            const remaining = yield* jj.execute({
              operation: "CheckpointStore.cleanupJjSnapshotRemainingBookmarks",
              cwd,
              args: [
                "--ignore-working-copy",
                "bookmark",
                "list",
                "-r",
                snapshot.revisionId,
                "-T",
                'name ++ "\n"',
              ],
            });
            if (remaining.stdout.trim().length === 0) {
              yield* jj
                .execute({
                  operation: "CheckpointStore.cleanupJjSnapshotRevision",
                  cwd,
                  args: ["--ignore-working-copy", "abandon", snapshot.revisionId],
                })
                .pipe(Effect.asVoid);
            }
          }
          yield* sql`
            DELETE FROM checkpoint_snapshots
            WHERE snapshot_id = ${snapshot.snapshotId}
              AND NOT EXISTS (
                SELECT 1
                FROM checkpoint_snapshot_aliases
                WHERE checkpoint_snapshot_aliases.snapshot_id = checkpoint_snapshots.snapshot_id
              )
          `.pipe(
            Effect.asVoid,
            mapCatalogError("CheckpointStore.cleanupJjSnapshotRows.deleteCatalogRow"),
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("checkpoint cleanup left an unaliased JJ snapshot", {
              cwd,
              snapshotId: snapshot.snapshotId,
              revision: snapshot.revisionId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      { discard: true, concurrency: 1 },
    );

  const abandonJjRevisionIfUnbookmarked = (cwd: string, revision: string) =>
    jj
      .execute({
        operation: "CheckpointStore.cleanupJjSupersededRevisionBookmarks",
        cwd,
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
                  operation: "CheckpointStore.cleanupJjSupersededRevision",
                  cwd,
                  args: ["--ignore-working-copy", "abandon", revision],
                })
                .pipe(Effect.asVoid),
        ),
        Effect.catch((error) =>
          Effect.logWarning("checkpoint cleanup left an unreferenced JJ revision", {
            cwd,
            revision,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );

  const snapshotJjWorkingCopy = (
    cwd: string,
    operation: string,
    recoverStaleWorkingCopy: boolean,
  ) => {
    const snapshot = () =>
      jj.execute({
        operation,
        cwd,
        args: ["status"],
      });
    if (!recoverStaleWorkingCopy) return snapshot();
    return snapshot().pipe(
      Effect.catchTag("JjCommandError", (error) => {
        const detail = error.detail.toLowerCase();
        if (!detail.includes("working copy") || !detail.includes("stale")) {
          return Effect.fail(error);
        }
        return jj
          .execute({
            operation: `${operation}.updateStale`,
            cwd,
            args: ["workspace", "update-stale"],
          })
          .pipe(Effect.flatMap(snapshot));
      }),
    );
  };

  const writeGitWorkingTree = (cwd: string, operation: string) =>
    Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "synara-fs-checkpoint-" }),
      (tempDir) =>
        Effect.gen(function* () {
          const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
          const indexEnv: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_INDEX_FILE: tempIndexPath,
          };
          if (yield* hasHeadCommit(cwd)) {
            yield* git.execute({
              operation,
              cwd,
              args: ["read-tree", "HEAD"],
              env: indexEnv,
            });
          }
          yield* git.execute({
            operation,
            cwd,
            args: ["add", "-A", "--", "."],
            env: indexEnv,
          });
          const writeTreeResult = yield* git.execute({
            operation,
            cwd,
            args: ["write-tree"],
            env: indexEnv,
          });
          const treeOid = writeTreeResult.stdout.trim();
          if (treeOid.length === 0) {
            return yield* new GitCommandError({
              operation,
              command: "git write-tree",
              cwd,
              detail: "git write-tree returned an empty tree oid.",
            });
          }
          return treeOid;
        }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.fail(
          new CheckpointInvariantError({
            operation,
            detail: "Failed to snapshot the Git working tree.",
            cause: error,
          }),
        ),
      ),
    );

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

      const treeOid = yield* writeGitWorkingTree(input.cwd, operation);
      const commitEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: "Synara",
        GIT_AUTHOR_EMAIL: "synara@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Synara",
        GIT_COMMITTER_EMAIL: "synara@users.noreply.github.com",
      };
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
    });

  const captureJjCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        yield* rememberJjRepositoryKey(input.cwd);
        if (input.skipIfExists) {
          const existingRevision = yield* resolveJjCheckpointRevision(
            input.cwd,
            input.checkpointRef,
          );
          if (existingRevision !== null) return;
        }

        // Snapshot the filesystem into @. Logical checkpoint refs are aliases
        // in SQLite; only one physical JJ bookmark/revision is retained for a
        // unique tree.
        yield* snapshotJjWorkingCopy(
          input.cwd,
          "CheckpointStore.captureCheckpoint.jjSnapshot",
          input.recoverStaleWorkingCopy === true,
        );
        const treeId = yield* readJjTreeId(input.cwd, "@");
        const existingSnapshot = yield* findSnapshotByTree(input.cwd, treeId);
        if (existingSnapshot) {
          if (yield* verifyJjSnapshot(input.cwd, existingSnapshot)) {
            const orphaned = yield* bindSnapshotAlias(
              input.cwd,
              input.checkpointRef,
              existingSnapshot.snapshotId,
            );
            yield* cleanupJjSnapshotRows(input.cwd, [
              orphaned,
              ...(yield* findUnaliasedSnapshots(input.cwd)),
            ]);
            return;
          }

          // Recover a capture interrupted after its bookmark was written but
          // before the catalog row was finalized.
          const anchoredRevision = yield* resolveJjBookmarkRevision(
            input.cwd,
            existingSnapshot.anchorRef,
          );
          if (
            anchoredRevision &&
            (yield* readJjTreeId(input.cwd, anchoredRevision)) === treeId
          ) {
            yield* finalizeSnapshot({
              cwd: input.cwd,
              snapshotId: existingSnapshot.snapshotId,
              revisionId: anchoredRevision,
              status: "ready",
            });
            const orphaned = yield* bindSnapshotAlias(
              input.cwd,
              input.checkpointRef,
              existingSnapshot.snapshotId,
            );
            yield* cleanupJjSnapshotRows(input.cwd, [
              orphaned,
              ...(yield* findUnaliasedSnapshots(input.cwd)),
            ]);
            return;
          }
        }

        const creatingSnapshot = yield* recordCreatingSnapshot(input.cwd, treeId);
        const previousAnchor = existingSnapshot?.anchorRef ?? null;
        const previousRevision =
          existingSnapshot?.revisionId ??
          (previousAnchor
            ? yield* resolveJjBookmarkRevision(input.cwd, previousAnchor)
            : null);
        const snapshotToken = randomUUID();
        const snapshotDescription = `synara checkpoint snapshot ${snapshotToken}`;
        const duplicateDescriptionTemplate = JSON.stringify(snapshotDescription);
        let duplicatedRevision: string | null = null;
        yield* Effect.gen(function* () {
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
          duplicatedRevision = snapshot.commitId;
          yield* recordCreatingSnapshotRevision({
            cwd: input.cwd,
            snapshotId: creatingSnapshot.snapshotId,
            revisionId: snapshot.commitId,
          });
          yield* jj.execute({
            operation: "CheckpointStore.captureCheckpoint.jjAnchor",
            cwd: input.cwd,
            args: [
              "--ignore-working-copy",
              "bookmark",
              "set",
              "--allow-backwards",
              "--revision",
              snapshot.commitId,
              creatingSnapshot.anchorRef,
            ],
          });
          yield* finalizeSnapshot({
            cwd: input.cwd,
            snapshotId: creatingSnapshot.snapshotId,
            revisionId: snapshot.commitId,
            status: "ready",
          });
          const orphaned = yield* bindSnapshotAlias(
            input.cwd,
            input.checkpointRef,
            creatingSnapshot.snapshotId,
          );

          if (previousAnchor && previousAnchor !== creatingSnapshot.anchorRef) {
            yield* jj
              .execute({
                operation: "CheckpointStore.captureCheckpoint.jjDeleteSupersededAnchor",
                cwd: input.cwd,
                args: ["--ignore-working-copy", "bookmark", "delete", previousAnchor],
                allowNonZeroExit: true,
              })
              .pipe(Effect.ignore);
          }
          if (previousRevision && previousRevision !== snapshot.commitId) {
            yield* abandonJjRevisionIfUnbookmarked(input.cwd, previousRevision);
          }
          yield* cleanupJjSnapshotRows(input.cwd, [
            orphaned,
            ...(yield* findUnaliasedSnapshots(input.cwd)),
          ]);
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              yield* jj
                .execute({
                  operation: "CheckpointStore.captureCheckpoint.jjCleanupAnchor",
                  cwd: input.cwd,
                  args: [
                    "--ignore-working-copy",
                    "bookmark",
                    "delete",
                    creatingSnapshot.anchorRef,
                  ],
                  allowNonZeroExit: true,
                })
                .pipe(Effect.ignore);
              if (duplicatedRevision) {
                yield* jj
                  .execute({
                    operation: "CheckpointStore.captureCheckpoint.jjCleanupRevision",
                    cwd: input.cwd,
                    args: ["--ignore-working-copy", "abandon", duplicatedRevision],
                    allowNonZeroExit: true,
                  })
                  .pipe(Effect.ignore);
              }
              yield* markSnapshotStatus(
                input.cwd,
                creatingSnapshot.snapshotId,
                "error",
              ).pipe(Effect.ignore);
            }),
          ),
        );
      }),
    );

  const captureCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    input.backend === "git" ? captureGitCheckpointOnce(input) : captureJjCheckpointOnce(input);

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

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) => {
    if (input.backend === "git") {
      return resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((revision) => revision !== null),
      );
    }
    return rememberJjRepositoryKey(input.cwd).pipe(
      Effect.flatMap(() => resolveJjCheckpointRevision(input.cwd, input.checkpointRef)),
      Effect.map((revision) => revision !== null),
    );
  };

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
        yield* rememberJjRepositoryKey(input.cwd);
        const sourceSnapshot = yield* findSnapshotByAlias(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (sourceSnapshot && (yield* verifyJjSnapshot(input.cwd, sourceSnapshot))) {
          const orphaned = yield* bindSnapshotAlias(
            input.cwd,
            input.toCheckpointRef,
            sourceSnapshot.snapshotId,
          );
          yield* cleanupJjSnapshotRows(input.cwd, [
            orphaned,
            ...(yield* findUnaliasedSnapshots(input.cwd)),
          ]);
          return true;
        }

        // Adopt checkpoints created before the snapshot catalog migration.
        // The existing legacy bookmark remains the sole physical anchor; the
        // target ref is only another catalog alias.
        const revision = yield* resolveLegacyJjCheckpointRevision(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (!revision) return false;
        const treeId = yield* readJjTreeId(input.cwd, revision);
        const legacyAnchor = jjCheckpointBookmark(input.fromCheckpointRef);
        const existingSnapshot = yield* findSnapshotByTree(input.cwd, treeId);
        let reusedExistingSnapshot = false;
        let snapshot: CheckpointSnapshotRow;
        if (existingSnapshot && (yield* verifyJjSnapshot(input.cwd, existingSnapshot))) {
          reusedExistingSnapshot = true;
          snapshot = existingSnapshot;
        } else {
          snapshot = yield* recordReadySnapshot({
            cwd: input.cwd,
            treeId,
            revisionId: revision,
            anchorRef: legacyAnchor,
          });
        }

        const orphanedSource = yield* bindSnapshotAlias(
          input.cwd,
          input.fromCheckpointRef,
          snapshot.snapshotId,
        );
        const orphanedTarget = yield* bindSnapshotAlias(
          input.cwd,
          input.toCheckpointRef,
          snapshot.snapshotId,
        );

        if (reusedExistingSnapshot && snapshot.anchorRef !== legacyAnchor) {
          yield* jj
            .execute({
              operation: "CheckpointStore.copyCheckpointRef.jjDeleteLegacyAnchor",
              cwd: input.cwd,
              args: ["--ignore-working-copy", "bookmark", "delete", legacyAnchor],
              allowNonZeroExit: true,
            })
            .pipe(Effect.ignore);
        } else if (
          existingSnapshot &&
          existingSnapshot.anchorRef !== snapshot.anchorRef
        ) {
          yield* jj
            .execute({
              operation: "CheckpointStore.copyCheckpointRef.jjDeleteSupersededAnchor",
              cwd: input.cwd,
              args: [
                "--ignore-working-copy",
                "bookmark",
                "delete",
                existingSnapshot.anchorRef,
              ],
              allowNonZeroExit: true,
            })
            .pipe(Effect.ignore);
          if (existingSnapshot.revisionId !== null) {
            yield* abandonJjRevisionIfUnbookmarked(
              input.cwd,
              existingSnapshot.revisionId,
            );
          }
        }
        yield* cleanupJjSnapshotRows(input.cwd, [
          orphanedSource,
          orphanedTarget,
          ...(yield* findUnaliasedSnapshots(input.cwd)),
        ]);
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
        yield* rememberJjRepositoryKey(input.cwd);
        const checkpointRevision = yield* resolveJjCheckpointRevision(
          input.cwd,
          input.checkpointRef,
        );
        const revision = checkpointRevision ?? (input.fallbackToHead === true ? "@-" : null);
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
      yield* rememberJjRepositoryKey(input.cwd);
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

  const diffGitCheckpointToWorkingCopy: CheckpointStoreShape["diffCheckpointToWorkingCopy"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpointToWorkingCopy";
      let fromCommitOid = yield* resolveCheckpointCommit(
        input.cwd,
        input.fromCheckpointRef,
      );
      if (!fromCommitOid && input.fallbackFromToHead === true) {
        fromCommitOid = yield* resolveHeadCommit(input.cwd);
      }
      if (!fromCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for working-copy diff operation.",
        });
      }
      const workingTreeOid = yield* writeGitWorkingTree(input.cwd, operation);
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
          workingTreeOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      return result.stdout;
    });

  const diffJjCheckpointToWorkingCopy: CheckpointStoreShape["diffCheckpointToWorkingCopy"] = (
    input,
  ) =>
    jj.withMutation(
      input.cwd,
      Effect.gen(function* () {
        yield* rememberJjRepositoryKey(input.cwd);
        yield* snapshotJjWorkingCopy(
          input.cwd,
          "CheckpointStore.diffCheckpointToWorkingCopy.jjSnapshot",
          input.recoverStaleWorkingCopy === true,
        );
        let fromRevision = yield* resolveJjCheckpointRevision(
          input.cwd,
          input.fromCheckpointRef,
        );
        if (!fromRevision && input.fallbackFromToHead === true) {
          fromRevision = "@-";
        }
        if (!fromRevision) {
          return yield* new CheckpointInvariantError({
            operation: "CheckpointStore.diffCheckpointToWorkingCopy.jj",
            detail: "Checkpoint bookmark is unavailable for working-copy diff operation.",
          });
        }
        const result = yield* jj.execute({
          operation: "CheckpointStore.diffCheckpointToWorkingCopy.jj",
          cwd: input.cwd,
          args: [
            "--ignore-working-copy",
            "diff",
            "--from",
            fromRevision,
            "--to",
            "@",
            "--git",
            ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
            "--",
            ".",
          ],
          maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });
        return result.stdout;
      }),
    );

  const diffCheckpointToWorkingCopy: CheckpointStoreShape["diffCheckpointToWorkingCopy"] = (
    input,
  ) =>
    input.backend === "git"
      ? diffGitCheckpointToWorkingCopy(input)
      : diffJjCheckpointToWorkingCopy(input);

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
        yield* rememberJjRepositoryKey(input.cwd);
        const [fromRevision, toRevision] = yield* Effect.all(
          [
            resolveJjCheckpointRevision(input.cwd, input.fromCheckpointRef),
            resolveJjCheckpointRevision(input.cwd, input.toCheckpointRef),
          ],
          { concurrency: "unbounded" },
        );
        if (!fromRevision || !toRevision) return false;

        const turnDiff = yield* jj.readRangeDiff(input.cwd, fromRevision, toRevision);
        const affectedPaths = [
          ...new Set(turnDiff.files.flatMap((file) => [file.sourcePath, file.targetPath])),
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
          args: ["restore", "--from", fromRevision, "--into", "@", "--", ...affectedPaths],
        });
        return true;
      }),
    );

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    input.backend === "git" ? reverseGitCheckpointDiff(input) : reverseJjCheckpointDiff(input);

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
        yield* rememberJjRepositoryKey(input.cwd);
        const catalogAliases = yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            findSnapshotByAlias(input.cwd, checkpointRef).pipe(
              Effect.map((snapshot) => ({ checkpointRef, snapshot })),
            ),
          { concurrency: 1 },
        );
        const legacyRefs = catalogAliases
          .filter(({ snapshot }) => snapshot === null)
          .map(({ checkpointRef }) => checkpointRef);
        const legacyResolved = yield* Effect.forEach(
          legacyRefs,
          (checkpointRef) =>
            resolveLegacyJjCheckpointRevision(input.cwd, checkpointRef).pipe(
              Effect.map((revision) => (revision === null ? null : { checkpointRef, revision })),
            ),
          { concurrency: 1 },
        );
        const existingLegacy = legacyResolved.filter(
          (
            entry,
          ): entry is {
            readonly checkpointRef: CheckpointRef;
            readonly revision: string;
          } => entry !== null,
        );

        const orphanedSnapshots = yield* deleteSnapshotAliases(
          input.cwd,
          input.checkpointRefs,
        );
        if (existingLegacy.length > 0) {
          yield* jj.execute({
            operation: "CheckpointStore.deleteCheckpointRefs.jjLegacy",
            cwd: input.cwd,
            args: [
              "--ignore-working-copy",
              "bookmark",
              "delete",
              ...existingLegacy.map((entry) => jjCheckpointBookmark(entry.checkpointRef)),
            ],
            allowNonZeroExit: true,
          });
        }

        yield* Effect.forEach(
          [...new Set(existingLegacy.map((entry) => entry.revision))],
          (revision) => abandonJjRevisionIfUnbookmarked(input.cwd, revision),
          { discard: true, concurrency: 1 },
        );
        yield* cleanupJjSnapshotRows(input.cwd, [
          ...orphanedSnapshots,
          ...(yield* findUnaliasedSnapshots(input.cwd)),
        ]);
      }),
    );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    input.backend === "git" ? deleteGitCheckpointRefs(input) : deleteJjCheckpointRefs(input);

  return {
    isRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    diffCheckpointToWorkingCopy,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
