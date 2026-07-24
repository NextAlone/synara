import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@synara/shared/githubRepository";
import { Effect } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type {
  JjBookmark,
  JjBookmarkRemote,
} from "./jjParsing.ts";
import type { JjWorkingCopyStatus } from "./Services/JjCore.ts";

export interface JjBookmarkRemoteResolution {
  readonly localBookmark: string;
  readonly remoteName: string;
  readonly remoteBookmark: string;
  readonly remoteRevision: string;
  readonly tracked: boolean;
  readonly synced: boolean;
  /** Same-name bookmark mappings can be pushed directly through JJ. */
  readonly nativePush: boolean;
}

export interface JjGitHubHeadContext {
  readonly headBranch: string;
  readonly selectors: ReadonlyArray<string>;
  readonly preferredSelector: string;
}

function appendUnique(values: string[], value: string | null) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function selectNativeRemote(
  bookmark: JjBookmark | undefined,
  trackedOnly: boolean,
): JjBookmarkRemote | null {
  return (
    bookmark?.remotes
      .filter(
        (remote) =>
          remote.targetChangeId !== null &&
          (!trackedOnly || remote.tracked),
      )
      .toSorted(
        (left, right) =>
          Number(right.tracked) - Number(left.tracked) ||
          Number(right.name === "origin") - Number(left.name === "origin") ||
          left.name.localeCompare(right.name),
      )[0] ?? null
  );
}

function resolutionFromNative(
  localBookmark: string,
  remote: JjBookmarkRemote,
): JjBookmarkRemoteResolution {
  return {
    localBookmark,
    remoteName: remote.name,
    remoteBookmark: localBookmark,
    remoteRevision: `${localBookmark}@${remote.name}`,
    tracked: remote.tracked,
    synced: remote.synced,
    nativePush: true,
  };
}

function remoteBookmarkFromMergeRef(mergeRef: string | null): string | null {
  const prefix = "refs/heads/";
  return mergeRef?.startsWith(prefix) ? mergeRef.slice(prefix.length) : null;
}

/**
 * Resolve a JJ bookmark's remote target. Most bookmarks use JJ's native
 * same-name tracking. Cross-fork PRs whose head name collides with an existing
 * local bookmark retain the Git bridge's explicit local-ref -> remote-ref
 * mapping and are the only case that needs remote Git fallback.
 */
export function resolveJjBookmarkRemote(input: {
  readonly git: GitCoreShape;
  readonly status: JjWorkingCopyStatus;
  readonly bookmark: string;
}) {
  const local = input.status.bookmarks.find(
    (bookmark) => bookmark.name === input.bookmark && bookmark.isLocal,
  );
  const trackedNative = selectNativeRemote(local, true);
  if (trackedNative) {
    return Effect.succeed(
      resolutionFromNative(input.bookmark, trackedNative),
    );
  }

  const upstreamSeparator =
    input.status.upstreamBookmark?.lastIndexOf("@") ?? -1;
  if (
    upstreamSeparator > 0 &&
    input.status.upstreamBookmark?.slice(0, upstreamSeparator) ===
      input.bookmark
  ) {
    return Effect.succeed({
      localBookmark: input.bookmark,
      remoteName: input.status.upstreamBookmark.slice(
        upstreamSeparator + 1,
      ),
      remoteBookmark: input.bookmark,
      remoteRevision: input.status.upstreamBookmark,
      tracked: true,
      synced:
        input.status.aheadCount === 0 &&
        input.status.behindCount === 0,
      nativePush: true,
    } satisfies JjBookmarkRemoteResolution);
  }

  if (!local) {
    return Effect.succeed(null);
  }

  const gitCwd = input.status.repository.gitStorePath;
  if (!gitCwd) {
    const native = selectNativeRemote(local, false);
    return Effect.succeed(
      native ? resolutionFromNative(input.bookmark, native) : null,
    );
  }

  return Effect.all(
    [
      input.git.readConfigValue(
        gitCwd,
        `branch.${input.bookmark}.remote`,
      ),
      input.git.readConfigValue(
        gitCwd,
        `branch.${input.bookmark}.merge`,
      ),
    ],
    { concurrency: 2 },
  ).pipe(
    Effect.map(([remoteName, mergeRef]) => {
      const remoteBookmark = remoteBookmarkFromMergeRef(mergeRef);
      if (remoteName && remoteName !== "." && remoteBookmark) {
        const remote = input.status.bookmarks
          .find((bookmark) => bookmark.name === remoteBookmark)
          ?.remotes.find((entry) => entry.name === remoteName);
        const sameName = remoteBookmark === input.bookmark;
        return {
          localBookmark: input.bookmark,
          remoteName,
          remoteBookmark,
          remoteRevision: `${remoteBookmark}@${remoteName}`,
          tracked: remote?.tracked ?? false,
          synced:
            sameName
              ? (remote?.synced ?? false)
              : local?.targetChangeId !== null &&
                local?.targetChangeId !== undefined &&
                local.targetChangeId === remote?.targetChangeId,
          nativePush: sameName,
        } satisfies JjBookmarkRemoteResolution;
      }

      const native = selectNativeRemote(local, false);
      return native
        ? resolutionFromNative(input.bookmark, native)
        : null;
    }),
  );
}

export function resolveJjGitHubHeadContext(input: {
  readonly git: GitCoreShape;
  readonly gitCwd: string;
  readonly bookmark: string;
  readonly remote: JjBookmarkRemoteResolution | null;
}) {
  const headBranch = input.remote?.remoteBookmark ?? input.bookmark;
  const remoteName = input.remote?.remoteName ?? null;
  if (!remoteName || remoteName === "origin") {
    return Effect.succeed({
      headBranch,
      selectors: [headBranch],
      preferredSelector: headBranch,
    } satisfies JjGitHubHeadContext);
  }

  return input.git
    .readConfigValue(input.gitCwd, `remote.${remoteName}.url`)
    .pipe(
      Effect.map((remoteUrl) => {
        const repositoryNameWithOwner =
          parseGitHubRepositoryNameWithOwnerFromRemoteUrl(remoteUrl);
        const owner = repositoryNameWithOwner?.split("/")[0] ?? null;
        const ownerSelector = owner ? `${owner}:${headBranch}` : null;
        const remoteSelector = `${remoteName}:${headBranch}`;
        const selectors: string[] = [];
        appendUnique(selectors, ownerSelector);
        appendUnique(
          selectors,
          remoteSelector !== ownerSelector ? remoteSelector : null,
        );
        appendUnique(selectors, headBranch);
        appendUnique(
          selectors,
          input.bookmark !== headBranch ? input.bookmark : null,
        );
        return {
          headBranch,
          selectors,
          preferredSelector: ownerSelector ?? headBranch,
        } satisfies JjGitHubHeadContext;
      }),
    );
}
