import type { OrchestrationProject, PullRequestDetail } from "@synara/contracts";
import { githubAvatarUrlForLogin } from "@synara/shared/githubAvatar";
import { Effect } from "effect";

import type { GitHubCliShape } from "../git/Services/GitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { isPullRequestMergeMethodAllowed } from "../pullRequests.logic";
import type { PullRequestServiceShape } from "./Services/PullRequestService";

type PullRequestOperations = Pick<
  PullRequestServiceShape,
  "detail" | "diff" | "action" | "comment" | "setPinned"
>;

export function makePullRequestOperations(dependencies: {
  github: GitHubCliShape;
  pins: ProjectPullRequestPinsShape;
  findProject: (
    projectId: Parameters<PullRequestServiceShape["detail"]>[0]["projectId"],
  ) => Effect.Effect<OrchestrationProject, unknown>;
  validateRepository: (repository: string) => Effect.Effect<string, Error>;
  validateProjectRepository: (
    project: OrchestrationProject,
    repository: string,
  ) => Effect.Effect<string, unknown>;
  resolveGitHubCwd: (project: OrchestrationProject) => Effect.Effect<string, unknown>;
  loadMergeCapabilities: (
    cwd: string,
    repository: string,
  ) => Effect.Effect<PullRequestDetail["mergeCapabilities"], unknown>;
  withGitHubRead: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  finalizeMutationCaches: (
    repository: string,
    number: number,
    options: { readonly invalidateReviewMatches: boolean },
  ) => Effect.Effect<void, never>;
}): PullRequestOperations {
  const loadDetail = (project: OrchestrationProject, repositoryInput: string, number: number) =>
    Effect.gen(function* () {
      const repository = yield* dependencies.validateProjectRepository(project, repositoryInput);
      const cwd = yield* dependencies.resolveGitHubCwd(project);
      const [owner = "", repo = ""] = repository.split("/");
      const [detail, mergeCapabilities, reviewCommentsResult] = yield* Effect.all(
        [
          dependencies.withGitHubRead(
            dependencies.github.getPullRequestDetail({
              cwd,
              repository,
              number,
            }),
          ),
          dependencies.loadMergeCapabilities(cwd, repository),
          dependencies
            .withGitHubRead(
              dependencies.github.getPullRequestReviewComments({
                cwd,
                host: "github.com",
                owner,
                repo,
                number,
              }),
            )
            .pipe(
              Effect.map((result) => ({ ...result, incomplete: false })),
              Effect.catch(() =>
                Effect.succeed({ comments: [], truncated: false, incomplete: true }),
              ),
            ),
        ],
        { concurrency: 3 },
      );
      const comments = [
        ...detail.comments,
        ...reviewCommentsResult.comments.map((comment) => ({
          id: comment.id,
          kind: "review-comment" as const,
          author: comment.author
            ? {
                login: comment.author,
                name: null,
                avatarUrl: githubAvatarUrlForLogin(comment.author),
                url: null,
              }
            : null,
          body: comment.body,
          createdAt: comment.createdAt ?? detail.updatedAt,
          updatedAt: null,
          url: comment.url,
          path: comment.path,
          reviewState: null,
        })),
      ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
      return {
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository,
        ...detail,
        comments,
        commentsTruncated: reviewCommentsResult.truncated,
        commentsIncomplete: reviewCommentsResult.incomplete,
        mergeCapabilities,
      } satisfies PullRequestDetail;
    });

  const detail: PullRequestServiceShape["detail"] = (input) =>
    dependencies
      .findProject(input.projectId)
      .pipe(Effect.flatMap((project) => loadDetail(project, input.repository, input.number)));

  const diff: PullRequestServiceShape["diff"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const cwd = yield* dependencies.resolveGitHubCwd(project);
      return yield* dependencies.withGitHubRead(
        dependencies.github.getPullRequestDiff({
          cwd,
          repository,
          number: input.number,
        }),
      );
    });

  const action: PullRequestServiceShape["action"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const cwd = yield* dependencies.resolveGitHubCwd(project);
      const finalizeCaches = dependencies.finalizeMutationCaches(repository, input.number, {
        invalidateReviewMatches: true,
      });

      if (input.action === "fast-forward") {
        const fastForwardStatus = yield* Effect.gen(function* () {
          const expectedHeadOid = input.expectedHeadOid?.trim() ?? "";
          if (expectedHeadOid.length === 0) {
            return yield* Effect.fail(
              new Error("Refresh the pull request before fast-forwarding its base branch."),
            );
          }

          // Bind the mutation to the exact revision rendered to the user. A fresh read prevents
          // a push that landed just before the click from being included without review.
          const before = yield* dependencies.github.getPullRequestDetail({
            cwd,
            repository,
            number: input.number,
          });
          if (before.state !== "open") {
            return yield* Effect.fail(new Error("Only an open pull request can be fast-forwarded."));
          }
          if (before.isDraft) {
            return yield* Effect.fail(
              new Error("Mark the pull request ready for review before fast-forwarding it."),
            );
          }
          if (!before.headOid) {
            return yield* Effect.fail(
              new Error("GitHub did not return the pull request head revision. Refresh and retry."),
            );
          }
          if (before.headOid !== expectedHeadOid) {
            return yield* Effect.fail(
              new Error(
                "The pull request received new commits after it was loaded. Refresh and review the new head before retrying.",
              ),
            );
          }

          const updated = yield* dependencies.github.fastForwardBranch({
            cwd,
            repository,
            branch: before.baseBranch,
            targetOid: expectedHeadOid,
          });
          if (updated.oid !== expectedHeadOid) {
            return yield* Effect.fail(
              new Error("GitHub returned an unexpected base branch revision after fast-forwarding."),
            );
          }

          // The ref response above is the authoritative mutation acknowledgement. GitHub marks
          // this as an indirect merge asynchronously, so a failed follow-up read must not turn a
          // successful ref update into a retryable error.
          const after = yield* dependencies.github
            .getPullRequestDetail({ cwd, repository, number: input.number })
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (after?.state === "merged") return "merged" as const;
          if (after?.headOid && after.headOid !== expectedHeadOid) return "head-changed" as const;
          return "base-updated" as const;
        }).pipe(Effect.ensuring(finalizeCaches));

        return {
          projectId: project.id,
          repository,
          number: input.number,
          workspaceRoot: project.workspaceRoot,
          fastForwardStatus,
        };
      }

      if (input.action === "merge") {
        const mergeMethod = input.mergeMethod ?? "merge";
        const capabilities = yield* dependencies.loadMergeCapabilities(cwd, repository);
        if (!isPullRequestMergeMethodAllowed(capabilities, mergeMethod)) {
          return yield* Effect.fail(
            new Error(`The repository does not allow the ${mergeMethod} merge method.`),
          );
        }
      }
      yield* dependencies.github
        .runPullRequestAction({
          cwd,
          repository,
          number: input.number,
          action: input.action,
          ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
        })
        .pipe(
          Effect.ensuring(finalizeCaches),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
      };
    });

  const comment: PullRequestServiceShape["comment"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      const repository = yield* dependencies.validateProjectRepository(project, input.repository);
      const cwd = yield* dependencies.resolveGitHubCwd(project);
      yield* dependencies.github
        .commentOnPullRequest({
          cwd,
          repository,
          number: input.number,
          body: input.body,
        })
        .pipe(
          Effect.ensuring(
            dependencies.finalizeMutationCaches(repository, input.number, {
              invalidateReviewMatches: false,
            }),
          ),
        );
      return {
        projectId: project.id,
        repository,
        number: input.number,
        workspaceRoot: project.workspaceRoot,
      };
    });

  const setPinned: PullRequestServiceShape["setPinned"] = (input) =>
    Effect.gen(function* () {
      const project = yield* dependencies.findProject(input.projectId);
      // Clearing an orphaned pin intentionally requires only a valid canonical repository key.
      const repository = yield* input.isPinned
        ? dependencies.validateProjectRepository(project, input.repository)
        : dependencies.validateRepository(input.repository);
      yield* dependencies.pins.setPinned({
        projectId: project.id,
        repositoryKey: repository.toLowerCase(),
        number: input.number,
        isPinned: input.isPinned,
      });
      return {
        projectId: project.id,
        repository,
        number: input.number,
        isPinned: input.isPinned,
      };
    });

  return { detail, diff, action, comment, setPinned };
}
