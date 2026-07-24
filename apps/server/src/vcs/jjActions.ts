import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type {
  GitActionProgressEvent,
  GitRunStackedActionResult,
  VcsRunStackedActionInput,
} from "@synara/contracts";
import { resolveAutoFeatureBranchName } from "@synara/shared/git";
import { Effect } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { GitHubCliShape, GitHubPullRequestSummary } from "../git/Services/GitHubCli.ts";
import type { TextGenerationShape } from "../git/Services/TextGeneration.ts";
import { buildGitTextGenerationCallInput } from "../git/textGenerationSelection.ts";
import { ProjectVcsError } from "./Errors.ts";
import type { JjBookmark } from "./jjParsing.ts";
import {
  type JjBookmarkRemoteResolution,
  type JjGitHubHeadContext,
  resolveJjBookmarkRemote,
  resolveJjGitHubHeadContext,
} from "./jjRemote.ts";
import type { JjCoreShape, JjWorkingCopyStatus } from "./Services/JjCore.ts";

type ProgressPayload<T> = T extends GitActionProgressEvent
  ? Omit<T, "actionId" | "cwd" | "action">
  : never;
type JjActionProgressPayload = ProgressPayload<GitActionProgressEvent>;

export interface JjActionDependencies {
  readonly jj: JjCoreShape;
  readonly git: GitCoreShape;
  readonly gitHubCli: GitHubCliShape;
  readonly textGeneration: TextGenerationShape;
}

export interface JjActionTarget {
  readonly cwd: string;
  readonly epoch: number;
  readonly preferredBookmark?: string | null;
}

function failPrecondition(operation: string, detail: string) {
  return Effect.fail(
    new ProjectVcsError({
      operation,
      reason: "operation-unsupported",
      detail,
    }),
  );
}

function selectBaseRemote(bookmark: JjBookmark | undefined) {
  return bookmark?.remotes
    .filter((remote) => remote.targetChangeId !== null)
    .toSorted(
      (left, right) =>
        Number(right.name === "origin") - Number(left.name === "origin") ||
        Number(right.tracked) - Number(left.tracked) ||
        left.name.localeCompare(right.name),
    )[0];
}

function isCommitAction(action: VcsRunStackedActionInput["action"]): boolean {
  return action === "commit" || action === "commit_push" || action === "commit_push_pr";
}

function fallbackCommitSubject(status: JjWorkingCopyStatus): string {
  const firstPath = status.files[0]?.path;
  return firstPath
    ? `chore: update ${nodePath.basename(firstPath)}`
    : "chore: update working copy";
}

function formatGeneratedMessage(subject: string, body: string): string {
  const normalizedSubject = subject.trim();
  const normalizedBody = body.trim();
  return normalizedBody.length > 0
    ? `${normalizedSubject}\n\n${normalizedBody}`
    : normalizedSubject;
}

function toPrStep(
  status: "created" | "opened_existing",
  pullRequest: GitHubPullRequestSummary,
) {
  return {
    status,
    url: pullRequest.url,
    number: pullRequest.number,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
    title: pullRequest.title,
  } as const;
}

export function makeJjActions(dependencies: JjActionDependencies) {
  const readStatus = (target: JjActionTarget) =>
    Effect.gen(function* () {
      const status = yield* dependencies.jj.status(target.cwd);
      const preferred = target.preferredBookmark;
      if (
        !preferred ||
        preferred === status.currentBookmark ||
        !status.bookmarks.some(
          (bookmark) => bookmark.name === preferred && bookmark.isLocal,
        )
      ) {
        return status;
      }
      const remote = yield* resolveJjBookmarkRemote({
        git: dependencies.git,
        status,
        bookmark: preferred,
      });
      const comparison = remote
        ? remote.synced
          ? { aheadCount: 0, behindCount: 0 }
          : yield* dependencies.jj.compareBookmarkToRemote(
              target.cwd,
              preferred,
              remote.remoteName,
              remote.remoteBookmark,
            )
        : { aheadCount: 0, behindCount: 0 };
      return {
        ...status,
        currentBookmark: preferred,
        upstreamBookmark: remote?.remoteRevision ?? null,
        aheadCount: comparison.aheadCount,
        behindCount: comparison.behindCount,
      };
    });

  const pull = (target: JjActionTarget) =>
    Effect.gen(function* () {
      const operation = "ProjectVcs.pull";
      const before = yield* readStatus(target);
      const bookmark = before.currentBookmark;
      const beforeRemote = bookmark
        ? yield* resolveJjBookmarkRemote({
            git: dependencies.git,
            status: before,
            bookmark,
          })
        : null;
      if (!bookmark || !beforeRemote) {
        return yield* failPrecondition(
          operation,
          "The current JJ bookmark does not track a remote bookmark.",
        );
      }
      if (before.hasChanges || before.hasConflicts) {
        return yield* failPrecondition(
          operation,
          "Commit or resolve the current JJ working-copy changes before pulling.",
        );
      }

      yield* dependencies.jj.fetchGit(target.cwd, beforeRemote.remoteName);
      const refreshed = yield* readStatus(target);
      const refreshedRemote = yield* resolveJjBookmarkRemote({
        git: dependencies.git,
        status: refreshed,
        bookmark,
      });
      if (!refreshedRemote) {
        return yield* failPrecondition(
          operation,
          "The current JJ bookmark lost its remote mapping after fetch.",
        );
      }
      const comparison = refreshedRemote.nativePush
        ? {
            aheadCount: refreshed.aheadCount,
            behindCount: refreshed.behindCount,
          }
        : yield* dependencies.jj.compareBookmarkToRemote(
            target.cwd,
            bookmark,
            refreshedRemote.remoteName,
            refreshedRemote.remoteBookmark,
          );
      if (comparison.aheadCount > 0 && comparison.behindCount > 0) {
        return yield* failPrecondition(
          operation,
          "The local and remote JJ bookmarks have diverged; rebase explicitly before pulling.",
        );
      }
      if (comparison.behindCount === 0) {
        return {
          backend: "jj",
          epoch: target.epoch,
          status: "skipped_up_to_date",
          ref: bookmark,
          upstreamRef: refreshedRemote.remoteRevision,
        };
      }

      yield* dependencies.jj.advanceBookmark(
        target.cwd,
        bookmark,
        refreshedRemote.remoteName,
        refreshedRemote.remoteBookmark,
      );
      return {
        backend: "jj",
        epoch: target.epoch,
        status: "pulled",
        ref: bookmark,
        upstreamRef: refreshedRemote.remoteRevision,
      };
    });

  const findOpenPullRequest = (
    gitCwd: string,
    head: JjGitHubHeadContext,
  ) =>
    Effect.gen(function* () {
      for (const headSelector of head.selectors) {
        const matches =
          yield* dependencies.gitHubCli.listOpenPullRequests({
            cwd: gitCwd,
            headSelector,
            limit: 10,
          });
        if (matches[0]) {
          return matches[0];
        }
      }
      return null;
    });

  const pushMappedBookmarkWithGit = (
    target: JjActionTarget,
    bookmark: string,
    remote: JjBookmarkRemoteResolution,
    gitCwd: string,
  ) =>
    dependencies.jj.withMutation(
      target.cwd,
      Effect.gen(function* () {
        yield* dependencies.jj.execute({
          operation: "JjActions.pushRemoteFallback.export",
          cwd: target.cwd,
          args: ["git", "export"],
        });
        yield* dependencies.git.execute({
          operation: "JjActions.pushRemoteFallback.push",
          cwd: gitCwd,
          args: [
            "push",
            "--porcelain",
            remote.remoteName,
            `refs/heads/${bookmark}:refs/heads/${remote.remoteBookmark}`,
          ],
        });
        yield* dependencies.jj.execute({
          operation: "JjActions.pushRemoteFallback.import",
          cwd: target.cwd,
          args: ["git", "import"],
        });
      }),
    );

  const createPullRequest = (
    target: JjActionTarget,
    input: VcsRunStackedActionInput,
    bookmark: string,
    status: JjWorkingCopyStatus,
  ) =>
    Effect.gen(function* () {
      const gitCwd = status.repository.gitStorePath;
      if (!gitCwd) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          "This JJ repository has no Git backing store for GitHub pull-request operations.",
        );
      }

      const remote = yield* resolveJjBookmarkRemote({
        git: dependencies.git,
        status,
        bookmark,
      });
      const headContext = yield* resolveJjGitHubHeadContext({
        git: dependencies.git,
        gitCwd,
        bookmark,
        remote,
      });
      const existing = yield* findOpenPullRequest(gitCwd, headContext);
      if (existing) {
        return toPrStep("opened_existing", existing);
      }

      const baseBranch = yield* dependencies.gitHubCli.getDefaultBranch({ cwd: gitCwd });
      if (!baseBranch) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          "GitHub did not report a default branch for this repository.",
        );
      }
      if (baseBranch === headContext.headBranch) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          `Cannot create a pull request from '${headContext.headBranch}' into itself.`,
        );
      }

      const bookmarks = yield* dependencies.jj.listBookmarks(target.cwd);
      const base = bookmarks.find((entry) => entry.name === baseBranch);
      const baseRemote = selectBaseRemote(base);
      const baseRevision = baseRemote
        ? `${baseBranch}@${baseRemote.name}`
        : baseBranch;
      const range = yield* dependencies.jj.readRangeDiff(
        target.cwd,
        baseRevision,
        bookmark,
      );
      const headRevision = yield* dependencies.jj.readRevisionIdentity(
        target.cwd,
        bookmark,
      );
      const generated = yield* dependencies.textGeneration.generatePrContent({
        cwd: target.cwd,
        baseBranch,
        headBranch: headContext.headBranch,
        commitSummary: headRevision.description,
        diffSummary: range.files
          .map((file) => `${file.status}: ${file.path}`)
          .join("\n")
          .slice(0, 20_000),
        diffPatch: range.patch.slice(0, 60_000),
        ...buildGitTextGenerationCallInput(input),
      });

      const bodyFile = nodePath.join(
        nodeOs.tmpdir(),
        `synara-jj-pr-${process.pid}-${randomUUID()}.md`,
      );
      yield* Effect.tryPromise({
        try: () => nodeFs.writeFile(bodyFile, generated.body, "utf8"),
        catch: () =>
          new ProjectVcsError({
            operation: "ProjectVcs.runStackedAction",
            reason: "operation-unsupported",
            detail: "Failed to prepare the temporary pull-request body.",
          }),
      });
      const existingAfterCreate = yield* dependencies.gitHubCli
        .createPullRequest({
          cwd: gitCwd,
          baseBranch,
          headSelector: headContext.preferredSelector,
          title: generated.title,
          bodyFile,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) =>
            findOpenPullRequest(gitCwd, headContext)
              .pipe(
                Effect.flatMap((match) =>
                  match ? Effect.succeed(match) : Effect.fail(error),
                ),
              ),
          ),
          Effect.ensuring(
            Effect.tryPromise({
              try: () => nodeFs.unlink(bodyFile),
              catch: () => undefined,
            }).pipe(Effect.ignore),
          ),
        );
      if (existingAfterCreate) {
        return toPrStep("opened_existing", existingAfterCreate);
      }

      const created = yield* findOpenPullRequest(gitCwd, headContext);
      return created
        ? toPrStep("created", created)
        : {
            status: "created" as const,
            baseBranch,
            headBranch: headContext.headBranch,
            title: generated.title,
          };
    });

  const runStackedAction = (
    target: JjActionTarget,
    input: VcsRunStackedActionInput,
    options?: {
      readonly publishProgress?: (
        event: GitActionProgressEvent,
      ) => Effect.Effect<void>;
    },
  ) => {
    const emit = (payload: JjActionProgressPayload) =>
      options?.publishProgress
        ? options.publishProgress({
            actionId: input.actionId,
            cwd: target.cwd,
            action: input.action,
            ...payload,
          } as GitActionProgressEvent)
        : Effect.void;

    const action = Effect.gen(function* () {
      let status = yield* readStatus(target);
      const wantsCommit = isCommitAction(input.action);
      const wantsPush =
        input.action === "push" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr" ||
        (input.action === "create_pr" &&
          (input.featureBranch ||
            status.upstreamBookmark === null ||
            status.aheadCount > 0));
      const wantsPr =
        input.action === "create_pr" || input.action === "commit_push_pr";
      const phases = [
        ...(input.featureBranch ? (["branch"] as const) : []),
        ...(wantsCommit ? (["commit"] as const) : []),
        ...(wantsPush ? (["push"] as const) : []),
        ...(wantsPr ? (["pr"] as const) : []),
      ];
      yield* emit({ kind: "action_started", phases });

      if (
        (input.action === "push" || input.action === "create_pr") &&
        (status.hasChanges || status.hasConflicts)
      ) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          input.action === "push"
            ? "Commit the current JJ changes before pushing."
            : "Commit the current JJ changes before creating a pull request.",
        );
      }
      if (!input.featureBranch && wantsPush && !status.currentBookmark) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          "Create or select a JJ bookmark before pushing.",
        );
      }
      if (!input.featureBranch && wantsPr && !status.currentBookmark) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          "Create or select a JJ bookmark before creating a pull request.",
        );
      }

      const selectedPaths = input.filePaths ?? [];
      const selectedFiles =
        selectedPaths.length === 0
          ? status.files
          : status.files.filter((file) => selectedPaths.includes(file.path));
      const selectedDiff =
        wantsCommit && selectedFiles.length > 0
          ? yield* dependencies.jj.readRevisionDiff(
              target.cwd,
              "@",
              selectedPaths,
            )
          : null;
      let commitMessage = input.commitMessage?.trim() ?? "";
      let preferredFeatureName = commitMessage.split(/\r?\n/u)[0]?.trim() ?? "";
      if (wantsCommit && selectedFiles.length > 0 && commitMessage.length === 0) {
        yield* emit({
          kind: "phase_started",
          phase: "commit",
          label: "Generating commit message...",
        });
        const generated = yield* dependencies.textGeneration
          .generateCommitMessage({
            cwd: target.cwd,
            branch: status.currentBookmark,
            stagedSummary: selectedFiles
              .map((file) => `${file.status}: ${file.path}`)
              .join("\n")
              .slice(0, 8_000),
            stagedPatch: (selectedDiff?.patch ?? "").slice(0, 50_000),
            ...(input.featureBranch ? { includeBranch: true } : {}),
            ...buildGitTextGenerationCallInput(input),
          })
          .pipe(
            Effect.catchTag("TextGenerationError", () =>
              Effect.succeed({
                subject: fallbackCommitSubject(status),
                body: "",
                branch: undefined,
              }),
            ),
          );
        commitMessage = formatGeneratedMessage(generated.subject, generated.body);
        preferredFeatureName = generated.branch ?? generated.subject;
      }

      let bookmark = status.currentBookmark;
      let branchStep: GitRunStackedActionResult["branch"] = {
        status: "skipped_not_requested",
      };
      if (input.featureBranch) {
        yield* emit({
          kind: "phase_started",
          phase: "branch",
          label: "Preparing feature bookmark...",
        });
        const bookmarks = yield* dependencies.jj.listBookmarks(target.cwd);
        bookmark = resolveAutoFeatureBranchName(
          bookmarks.filter((entry) => entry.isLocal).map((entry) => entry.name),
          preferredFeatureName ||
            status.revision.description ||
            `change-${status.revision.changeId.slice(0, 8)}`,
        );
        yield* dependencies.jj.createBookmark(target.cwd, bookmark, "@-");
        branchStep = { status: "created", name: bookmark };
      }

      let commitStep: GitRunStackedActionResult["commit"] = {
        status: "skipped_not_requested",
      };
      if (wantsCommit) {
        if (selectedFiles.length === 0) {
          commitStep = { status: "skipped_no_changes" };
        } else {
          yield* emit({
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          });
          const committed = yield* dependencies.jj.commitWorkingCopy(
            target.cwd,
            commitMessage || fallbackCommitSubject(status),
            selectedPaths,
          );
          if (bookmark) {
            yield* dependencies.jj.setBookmark(
              target.cwd,
              bookmark,
              committed.commitId,
            );
          }
          commitStep = {
            status: "created",
            commitSha: committed.commitId,
            subject:
              (commitMessage || fallbackCommitSubject(status)).split(/\r?\n/u)[0] ??
              fallbackCommitSubject(status),
          };
          status = yield* readStatus(target);
          bookmark = bookmark ?? status.currentBookmark;
        }
      }

      let pushStep: GitRunStackedActionResult["push"] = {
        status: "skipped_not_requested",
      };
      if (wantsPush) {
        if (!bookmark) {
          return yield* failPrecondition(
            "ProjectVcs.runStackedAction",
            "Create or select a JJ bookmark before pushing.",
          );
        }
        yield* emit({
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        });
        const beforePush = yield* readStatus(target);
        const beforeRemote = yield* resolveJjBookmarkRemote({
          git: dependencies.git,
          status: beforePush,
          bookmark,
        });
        if (beforeRemote?.synced) {
          pushStep = { status: "skipped_up_to_date" };
        } else {
          if (!beforePush.repository.gitStorePath) {
            return yield* failPrecondition(
              "ProjectVcs.runStackedAction",
              "This JJ repository has no Git backing store for remote push.",
            );
          }
          yield* beforeRemote && !beforeRemote.nativePush
            ? pushMappedBookmarkWithGit(
                target,
                bookmark,
                beforeRemote,
                beforePush.repository.gitStorePath,
              )
            : beforeRemote
              ? dependencies.jj.pushBookmark(
                  target.cwd,
                  bookmark,
                  beforeRemote.remoteName,
                )
            : dependencies.jj.pushBookmark(target.cwd, bookmark);
          const afterPush = yield* readStatus(target);
          const afterRemote = yield* resolveJjBookmarkRemote({
            git: dependencies.git,
            status: afterPush,
            bookmark,
          });
          pushStep = {
            status: "pushed",
            branch: bookmark,
            upstreamBranch:
              afterRemote
                ? afterRemote.remoteRevision
                : `${bookmark}@origin`,
            setUpstream: beforeRemote === null,
          };
          status = afterPush;
        }
      }

      let prStep: GitRunStackedActionResult["pr"] = {
        status: "skipped_not_requested",
      };
      if (wantsPr) {
        if (!bookmark) {
          return yield* failPrecondition(
            "ProjectVcs.runStackedAction",
            "Create or select a JJ bookmark before creating a pull request.",
          );
        }
        yield* emit({
          kind: "phase_started",
          phase: "pr",
          label: "Creating pull request...",
        });
        prStep = yield* createPullRequest(target, input, bookmark, status);
      }

      const result: GitRunStackedActionResult = {
        action: input.action,
        branch: branchStep,
        commit: commitStep,
        push: pushStep,
        pr: prStep,
      };
      yield* emit({ kind: "action_finished", result });
      return result;
    });

    return action.pipe(
      Effect.catch((error) =>
        emit({
          kind: "action_failed",
          phase: null,
          message: error instanceof Error ? error.message : "JJ action failed.",
        }).pipe(Effect.andThen(Effect.fail(error))),
      ),
    );
  };

  return { pull, runStackedAction };
}
