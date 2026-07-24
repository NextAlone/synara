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

import type { GitHubCliShape, GitHubPullRequestSummary } from "../git/Services/GitHubCli.ts";
import type { TextGenerationShape } from "../git/Services/TextGeneration.ts";
import { buildGitTextGenerationCallInput } from "../git/textGenerationSelection.ts";
import { ProjectVcsError } from "./Errors.ts";
import type { JjCoreShape, JjWorkingCopyStatus } from "./Services/JjCore.ts";

type ProgressPayload<T> = T extends GitActionProgressEvent
  ? Omit<T, "actionId" | "cwd" | "action">
  : never;
type JjActionProgressPayload = ProgressPayload<GitActionProgressEvent>;

export interface JjActionDependencies {
  readonly jj: JjCoreShape;
  readonly gitHubCli: GitHubCliShape;
  readonly textGeneration: TextGenerationShape;
}

export interface JjActionTarget {
  readonly cwd: string;
  readonly epoch: number;
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

function remoteNameFromUpstream(upstream: string | null): string | null {
  const separator = upstream?.lastIndexOf("@") ?? -1;
  return separator > 0 ? upstream!.slice(separator + 1) : null;
}

function selectBookmarkRemote(
  status: JjWorkingCopyStatus,
  bookmarkName: string,
) {
  return status.bookmarks
    .find((bookmark) => bookmark.name === bookmarkName)
    ?.remotes.filter((remote) => remote.targetChangeId !== null)
    .toSorted(
      (left, right) =>
        Number(right.tracked) - Number(left.tracked) ||
        Number(right.name === "origin") - Number(left.name === "origin") ||
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
  const pull = (target: JjActionTarget) =>
    Effect.gen(function* () {
      const operation = "ProjectVcs.pull";
      const before = yield* dependencies.jj.status(target.cwd);
      const bookmark = before.currentBookmark;
      const remoteName = remoteNameFromUpstream(before.upstreamBookmark);
      if (!bookmark || !remoteName) {
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

      yield* dependencies.jj.fetchGit(target.cwd, remoteName);
      const refreshed = yield* dependencies.jj.status(target.cwd);
      if (refreshed.aheadCount > 0 && refreshed.behindCount > 0) {
        return yield* failPrecondition(
          operation,
          "The local and remote JJ bookmarks have diverged; rebase explicitly before pulling.",
        );
      }
      if (refreshed.behindCount === 0) {
        return {
          backend: "jj",
          epoch: target.epoch,
          status: "skipped_up_to_date",
          ref: bookmark,
          upstreamRef: refreshed.upstreamBookmark,
        };
      }

      yield* dependencies.jj.advanceBookmark(target.cwd, bookmark, remoteName);
      return {
        backend: "jj",
        epoch: target.epoch,
        status: "pulled",
        ref: bookmark,
        upstreamRef: `${bookmark}@${remoteName}`,
      };
    });

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

      const existing = yield* dependencies.gitHubCli.listOpenPullRequests({
        cwd: gitCwd,
        headSelector: bookmark,
        limit: 10,
      });
      if (existing[0]) {
        return toPrStep("opened_existing", existing[0]);
      }

      const baseBranch = yield* dependencies.gitHubCli.getDefaultBranch({ cwd: gitCwd });
      if (!baseBranch) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          "GitHub did not report a default branch for this repository.",
        );
      }
      if (baseBranch === bookmark) {
        return yield* failPrecondition(
          "ProjectVcs.runStackedAction",
          `Cannot create a pull request from '${bookmark}' into itself.`,
        );
      }

      const bookmarks = yield* dependencies.jj.listBookmarks(target.cwd);
      const base = bookmarks.find((entry) => entry.name === baseBranch);
      const preferredRemote =
        remoteNameFromUpstream(status.upstreamBookmark) ?? "origin";
      const baseRemote = base?.remotes.find(
        (remote) =>
          remote.name === preferredRemote && remote.targetChangeId !== null,
      );
      const baseRevision = baseRemote
        ? `${baseBranch}@${preferredRemote}`
        : baseBranch;
      const range = yield* dependencies.jj.readRangeDiff(
        target.cwd,
        baseRevision,
        bookmark,
      );
      const head = yield* dependencies.jj.readRevisionIdentity(target.cwd, bookmark);
      const generated = yield* dependencies.textGeneration.generatePrContent({
        cwd: target.cwd,
        baseBranch,
        headBranch: bookmark,
        commitSummary: head.description,
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
          headSelector: bookmark,
          title: generated.title,
          bodyFile,
        })
        .pipe(
          Effect.as(null),
          Effect.catch((error) =>
            dependencies.gitHubCli
              .listOpenPullRequests({
                cwd: gitCwd,
                headSelector: bookmark,
                limit: 10,
              })
              .pipe(
                Effect.flatMap((matches) =>
                  matches[0] ? Effect.succeed(matches[0]) : Effect.fail(error),
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

      const created = yield* dependencies.gitHubCli.listOpenPullRequests({
        cwd: gitCwd,
        headSelector: bookmark,
        limit: 10,
      });
      return created[0]
        ? toPrStep("created", created[0])
        : {
            status: "created" as const,
            baseBranch,
            headBranch: bookmark,
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
      let status = yield* dependencies.jj.status(target.cwd);
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
          status = yield* dependencies.jj.status(target.cwd);
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
        const beforePush = yield* dependencies.jj.status(target.cwd);
        const beforeRemote = selectBookmarkRemote(beforePush, bookmark);
        if (beforeRemote?.synced) {
          pushStep = { status: "skipped_up_to_date" };
        } else {
          yield* dependencies.jj.pushBookmark(target.cwd, bookmark);
          const afterPush = yield* dependencies.jj.status(target.cwd);
          const afterRemote = selectBookmarkRemote(afterPush, bookmark);
          pushStep = {
            status: "pushed",
            branch: bookmark,
            upstreamBranch:
              afterRemote
                ? `${bookmark}@${afterRemote.name}`
                : `${bookmark}@origin`,
            setUpstream: beforeRemote === undefined,
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
