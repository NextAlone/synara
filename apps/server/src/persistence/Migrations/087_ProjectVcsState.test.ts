import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("087_ProjectVcsState", (it) => {
  it.effect("adds an exclusive project VCS state with a legacy-safe default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 86 });

      const executed = yield* runMigrations({ toMigrationInclusive: 87 });
      assert.deepStrictEqual(executed, [[87, "ProjectVcsState"]]);

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`SELECT name, "notnull", dflt_value FROM pragma_table_info('projection_projects')`;
      const vcsColumn = columns.find((column) => column.name === "vcs_state_json");
      assert.deepStrictEqual(vcsColumn, {
        name: "vcs_state_json",
        notnull: 1,
        dflt_value: `'{"epoch":0,"binding":null}'`,
      });
    }),
  );

  it.effect("is idempotent", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const second = yield* runMigrations();
      assert.deepStrictEqual(second, []);
    }),
  );
});
