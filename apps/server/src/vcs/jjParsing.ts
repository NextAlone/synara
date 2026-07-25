import { TrimmedNonEmptyString } from "@synara/contracts";
import { Schema } from "effect";

export const JJ_REVISION_IDENTITY_TEMPLATE =
  '"{\\"changeId\\":" ++ json(change_id) ++ ",\\"commitId\\":" ++ json(commit_id) ++ ",\\"description\\":" ++ description.first_line().escape_json() ++ "}\\n"';

export const JJ_BOOKMARK_TEMPLATE =
  '"{\\"name\\":" ++ json(self.name()) ++ ",\\"remote\\":" ++ json(self.remote()) ++ ",\\"tracked\\":" ++ json(self.tracked()) ++ ",\\"synced\\":" ++ json(self.synced()) ++ ",\\"conflicted\\":" ++ json(self.conflict()) ++ ",\\"targetChangeId\\":" ++ if(self.normal_target(), json(self.normal_target().change_id()), "null") ++ "}\\n"';

export const JJ_BOOKMARK_NAME_TEMPLATE = '"{\\"name\\":" ++ json(self.name()) ++ "}\\n"';

export const JJ_DIFF_ENTRY_TEMPLATE =
  '"{\\"status\\":" ++ json(status) ++ ",\\"sourcePath\\":" ++ json(source.path()) ++ ",\\"targetPath\\":" ++ json(target.path()) ++ ",\\"conflicted\\":" ++ json(source.conflict() || target.conflict()) ++ "}\\n"';

export const JJ_WORKSPACE_TEMPLATE = 'json(name) ++ "\\0" ++ json(root) ++ "\\0"';

export interface JjRevisionIdentity {
  readonly changeId: string;
  readonly commitId: string;
  readonly description: string;
}

export interface JjBookmarkRemote {
  readonly name: string;
  readonly targetChangeId: string | null;
  readonly tracked: boolean;
  readonly synced: boolean;
}

export interface JjBookmark {
  readonly name: string;
  readonly targetChangeId: string | null;
  readonly isLocal: boolean;
  readonly current: boolean;
  readonly conflicted: boolean;
  readonly remotes: ReadonlyArray<JjBookmarkRemote>;
}

export type JjFileChangeStatus = "modified" | "added" | "removed" | "copied" | "renamed";

export interface JjFileChange {
  readonly status: JjFileChangeStatus;
  readonly path: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly conflicted: boolean;
}

export type JjWorkspaceRegistration =
  | { readonly kind: "absent" }
  | { readonly kind: "stale" }
  | { readonly kind: "present"; readonly root: string };

export interface JjWorkspace {
  readonly name: string;
  readonly registration: Exclude<JjWorkspaceRegistration, { readonly kind: "absent" }>;
}

export interface JjGitRemote {
  readonly name: string;
  readonly url: string;
}

const RawRevisionIdentity = Schema.Struct({
  changeId: TrimmedNonEmptyString,
  commitId: TrimmedNonEmptyString,
  description: Schema.String,
});

const RawBookmark = Schema.Struct({
  name: TrimmedNonEmptyString,
  remote: Schema.NullOr(TrimmedNonEmptyString),
  tracked: Schema.Boolean,
  synced: Schema.Boolean,
  conflicted: Schema.Boolean,
  targetChangeId: Schema.NullOr(TrimmedNonEmptyString),
});

const RawBookmarkName = Schema.Struct({
  name: TrimmedNonEmptyString,
});

const RawDiffEntry = Schema.Struct({
  status: Schema.Literals(["modified", "added", "removed", "copied", "renamed"]),
  sourcePath: Schema.NonEmptyString,
  targetPath: Schema.NonEmptyString,
  conflicted: Schema.Boolean,
});

const RawWorkspace = Schema.Struct({
  name: TrimmedNonEmptyString,
  root: Schema.NonEmptyString,
});

function parseJsonLines<
  S extends Schema.Top & {
    readonly DecodingServices: never;
  },
>(output: string, schema: S): Array<S["Type"]> {
  const decode = Schema.decodeUnknownSync(schema);
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decode(JSON.parse(line)));
}

export function parseJjRevisionIdentity(output: string): JjRevisionIdentity {
  const rows = parseJsonLines(output, RawRevisionIdentity);
  if (rows.length !== 1) {
    throw new Error(`Expected one JJ revision identity, received ${rows.length}.`);
  }
  return rows[0]!;
}

export function parseJjBookmarks(output: string, currentChangeId: string): JjBookmark[] {
  const rows = parseJsonLines(output, RawBookmark);
  const order: string[] = [];
  const byName = new Map<
    string,
    {
      targetChangeId: string | null;
      isLocal: boolean;
      conflicted: boolean;
      remotes: JjBookmarkRemote[];
    }
  >();

  for (const row of rows) {
    const existing = byName.get(row.name);
    const aggregate = existing ?? {
      targetChangeId: null,
      isLocal: false,
      conflicted: false,
      remotes: [],
    };
    if (!existing) {
      order.push(row.name);
    }

    aggregate.conflicted = aggregate.conflicted || row.conflicted;
    if (row.remote === null) {
      aggregate.isLocal = true;
      aggregate.targetChangeId = row.targetChangeId;
    } else {
      aggregate.targetChangeId ??= row.targetChangeId;
      aggregate.remotes.push({
        name: row.remote,
        targetChangeId: row.targetChangeId,
        tracked: row.tracked,
        synced: row.synced,
      });
    }
    byName.set(row.name, aggregate);
  }

  return order.map((name) => {
    const aggregate = byName.get(name)!;
    return {
      name,
      targetChangeId: aggregate.targetChangeId,
      isLocal: aggregate.isLocal,
      current: aggregate.isLocal && aggregate.targetChangeId === currentChangeId,
      conflicted: aggregate.conflicted,
      remotes: aggregate.remotes.toSorted((left, right) => left.name.localeCompare(right.name)),
    };
  });
}

export function parseJjBookmarkNames(output: string): string[] {
  return [...new Set(parseJsonLines(output, RawBookmarkName).map((entry) => entry.name))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

export function parseJjFileChanges(output: string): JjFileChange[] {
  return parseJsonLines(output, RawDiffEntry).map((entry) => ({
    ...entry,
    path: entry.status === "removed" ? entry.sourcePath : entry.targetPath,
  }));
}

export function parseJjWorkspaces(output: string): JjWorkspace[] {
  const fields = output.split("\0");
  if (fields.pop() !== "") {
    throw new Error("Expected NUL-terminated JJ workspace fields.");
  }
  if (fields.length % 2 !== 0) {
    throw new Error(`Expected JJ workspace name/root pairs, received ${fields.length} fields.`);
  }

  const decode = Schema.decodeUnknownSync(RawWorkspace);
  const workspaces: JjWorkspace[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const nameField = fields[index]!;
    const rootField = fields[index + 1]!;
    const workspace = decode({
      name: JSON.parse(nameField),
      // jj renders a missing workspace path as an unescaped inline template
      // error, so it cannot be parsed as JSON. The NUL framing keeps that
      // sentinel isolated without weakening validation for any other field.
      root: rootField.startsWith("<Error:") ? rootField : JSON.parse(rootField),
    });
    workspaces.push({
      name: workspace.name,
      registration: workspace.root.startsWith("<Error:")
        ? { kind: "stale" }
        : { kind: "present", root: workspace.root },
    });
  }
  return workspaces;
}

export function parseJjGitRemotes(output: string): JjGitRemote[] {
  return output
    .split("\n")
    .flatMap((line) => {
      const separator = line.search(/\s/u);
      if (separator <= 0) return [];
      const name = line.slice(0, separator).trim();
      const url = line.slice(separator).trim();
      return name.length > 0 && url.length > 0 ? [{ name, url }] : [];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function findJjWorkspaceRegistration(
  workspaces: ReadonlyArray<JjWorkspace>,
  workspaceName: string,
): JjWorkspaceRegistration {
  return (
    workspaces.find((workspace) => workspace.name === workspaceName)?.registration ?? {
      kind: "absent",
    }
  );
}
