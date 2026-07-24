// FILE: 087_ProjectVcsState.ts
// Purpose: Persist the exclusive project-level VCS binding and stale-request epoch.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { columnExists } from "./schemaHelpers.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  if (!(yield* columnExists(sql, "projection_projects", "vcs_state_json"))) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN vcs_state_json TEXT NOT NULL
      DEFAULT '{"epoch":0,"binding":null}'
    `;
  }
});
