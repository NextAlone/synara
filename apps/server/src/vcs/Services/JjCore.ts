import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { JjCommandError } from "../Errors.ts";
import type {
  JjBookmark,
  JjFileChange,
  JjGitRemote,
  JjRevisionIdentity,
  JjWorkspace,
  JjWorkspaceRegistration,
} from "../jjParsing.ts";

export interface ExecuteJjInput {
  readonly operation: string;
  readonly cwd: string;
  /**
   * Arguments after the mandatory machine flags. The live executor always
   * prepends `--no-pager --color never`.
   */
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface ExecuteJjResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface JjRepositoryInfo {
  readonly workspaceRoot: string;
  /** Canonical shared `.jj/repo` directory used to serialize repository mutations. */
  readonly repositoryStorePath: string;
  /** Present only when JJ exposes a Git backing store suitable for explicit remote fallback. */
  readonly gitStorePath: string | null;
}

export interface JjWorkingCopyStatus {
  readonly repository: JjRepositoryInfo;
  readonly revision: JjRevisionIdentity;
  /** Nearest local bookmark at or behind the working-copy change. */
  readonly currentBookmark: string | null;
  readonly upstreamBookmark: string | null;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly bookmarks: ReadonlyArray<JjBookmark>;
  readonly files: ReadonlyArray<JjFileChange>;
  readonly hasChanges: boolean;
  readonly hasConflicts: boolean;
}

export interface JjDiffResult {
  readonly patch: string;
  readonly files: ReadonlyArray<JjFileChange>;
}

export interface JjBookmarkRemoteComparison {
  readonly aheadCount: number;
  readonly behindCount: number;
}

export interface JjCreateWorkspaceInput {
  readonly repositoryPath: string;
  readonly workspacePath: string;
  readonly workspaceName: string;
  readonly revision: string;
  readonly message: string;
}

export interface JjCreatedWorkspace {
  readonly name: string;
  readonly path: string;
  readonly revision: JjRevisionIdentity;
}

export interface JjCoreShape {
  readonly execute: (input: ExecuteJjInput) => Effect.Effect<ExecuteJjResult, JjCommandError>;
  readonly withMutation: <A, E, R>(
    cwd: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | JjCommandError, R>;
  readonly detectRepository: (
    cwd: string,
  ) => Effect.Effect<JjRepositoryInfo | null, JjCommandError>;
  readonly initRepository: (cwd: string) => Effect.Effect<void, JjCommandError>;
  readonly readRevisionIdentity: (
    cwd: string,
    revision?: string,
  ) => Effect.Effect<JjRevisionIdentity, JjCommandError>;
  readonly listBookmarks: (cwd: string) => Effect.Effect<JjBookmark[], JjCommandError>;
  readonly listGitRemotes: (cwd: string) => Effect.Effect<JjGitRemote[], JjCommandError>;
  readonly resolveNearestBookmark: (cwd: string) => Effect.Effect<string | null, JjCommandError>;
  readonly status: (cwd: string) => Effect.Effect<JjWorkingCopyStatus, JjCommandError>;
  readonly readRevisionDiff: (
    cwd: string,
    revision?: string,
    filePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<JjDiffResult, JjCommandError>;
  readonly readRangeDiff: (
    cwd: string,
    fromRevision: string,
    toRevision: string,
  ) => Effect.Effect<JjDiffResult, JjCommandError>;
  readonly listWorkspaces: (repositoryPath: string) => Effect.Effect<JjWorkspace[], JjCommandError>;
  readonly getWorkspaceRegistration: (
    repositoryPath: string,
    workspaceName: string,
  ) => Effect.Effect<JjWorkspaceRegistration, JjCommandError>;
  readonly createWorkspace: (
    input: JjCreateWorkspaceInput,
  ) => Effect.Effect<JjCreatedWorkspace, JjCommandError>;
  readonly forgetWorkspace: (
    repositoryPath: string,
    workspaceName: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly createBookmark: (
    cwd: string,
    name: string,
    revision: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly createAvailableBookmark: (
    cwd: string,
    desiredName: string,
    revision: string,
  ) => Effect.Effect<string, JjCommandError>;
  readonly deleteBookmark: (cwd: string, name: string) => Effect.Effect<void, JjCommandError>;
  readonly trackBookmark: (
    cwd: string,
    remoteBookmark: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly setBookmark: (
    cwd: string,
    name: string,
    revision: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly startNewChange: (
    cwd: string,
    revision: string,
    message: string,
  ) => Effect.Effect<JjRevisionIdentity, JjCommandError>;
  readonly describeRevision: (
    cwd: string,
    revision: string,
    message: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly commitWorkingCopy: (
    cwd: string,
    message: string,
    filePaths?: ReadonlyArray<string>,
  ) => Effect.Effect<JjRevisionIdentity, JjCommandError>;
  /** Import refs changed through the explicit Git remote fallback. */
  readonly importGit: (cwd: string) => Effect.Effect<void, JjCommandError>;
  readonly fetchGit: (cwd: string, remoteName?: string) => Effect.Effect<void, JjCommandError>;
  readonly advanceBookmark: (
    cwd: string,
    bookmark: string,
    remoteName: string,
    remoteBookmark?: string,
  ) => Effect.Effect<void, JjCommandError>;
  readonly compareBookmarkToRemote: (
    cwd: string,
    bookmark: string,
    remoteName: string,
    remoteBookmark?: string,
  ) => Effect.Effect<JjBookmarkRemoteComparison, JjCommandError>;
  readonly pushBookmark: (
    cwd: string,
    bookmark: string,
    remoteName?: string,
  ) => Effect.Effect<void, JjCommandError>;
}

export class JjCore extends ServiceMap.Service<JjCore, JjCoreShape>()(
  "synara/vcs/Services/JjCore",
) {}
