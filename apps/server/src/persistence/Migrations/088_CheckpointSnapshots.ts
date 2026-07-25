import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      backend TEXT NOT NULL,
      repository_key TEXT NOT NULL,
      revision_id TEXT,
      tree_id TEXT NOT NULL,
      anchor_ref TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_verified_at TEXT,
      UNIQUE (backend, repository_key, tree_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoint_snapshot_aliases (
      repository_key TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      alias_kind TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (repository_key, checkpoint_ref),
      FOREIGN KEY (snapshot_id) REFERENCES checkpoint_snapshots(snapshot_id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_checkpoint_snapshot_aliases_snapshot
    ON checkpoint_snapshot_aliases(snapshot_id)
  `;
});
