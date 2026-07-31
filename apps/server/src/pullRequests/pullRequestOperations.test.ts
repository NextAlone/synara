import { ProjectId, type OrchestrationProject } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import { GitHubCliError } from "../git/Errors";
import type { GitHubCliShape, GitHubPullRequestDetailData } from "../git/Services/GitHubCli";
import { createGitHubCliWithFakeGh } from "../git/testing/fakeGitHubCli";
import type { ProjectPullRequestPinsShape } from "../persistence/Services/ProjectPullRequestPins";
import { makePullRequestOperations } from "./pullRequestOperations";

const now = "2026-07-15T00:00:00.000Z";
const reviewedHeadOid = "2222222222222222222222222222222222222222";

const project: OrchestrationProject = {
  id: ProjectId.makeUnsafe("project-detail"),
  kind: "project",
  title: "Detail",
  workspaceRoot: "/tmp/detail",
  defaultModelSelection: null,
  scripts: [],
  isPinned: false,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
};

const detail: GitHubPullRequestDetailData = {
  number: 42,
  title: "Parallel detail",
  body: "",
  url: "https://github.com/acme/widgets/pull/42",
  author: null,
  state: "open",
  isDraft: false,
  mergeable: null,
  mergeability: "unknown",
  mergeStateStatus: null,
  reviewDecision: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  headBranch: "feature",
  baseBranch: "main",
  headOid: reviewedHeadOid,
  createdAt: now,
  updatedAt: now,
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commits: [],
};

type PullRequestOperationDependencies = Parameters<typeof makePullRequestOperations>[0];

function makeDependencies(
  github: GitHubCliShape,
  overrides: Partial<PullRequestOperationDependencies> = {},
): PullRequestOperationDependencies {
  return {
    github,
    pins: {
      listByProjectIds: () => Effect.succeed([]),
      setPinned: () => Effect.void,
    },
    findProject: () => Effect.succeed(project),
    validateRepository: (repository) => Effect.succeed(repository),
    validateProjectRepository: (_project, repository) => Effect.succeed(repository),
    resolveGitHubCwd: () => Effect.succeed(project.workspaceRoot),
    loadMergeCapabilities: () =>
      Effect.succeed({
        merge: true,
        squash: true,
        rebase: true,
        deleteBranchOnMerge: false,
      }),
    withGitHubRead: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
    finalizeMutationCaches: () => Effect.void,
    ...overrides,
  };
}

describe("makePullRequestOperations", () => {
  it("uses the backend-resolved Git cwd for pull-request diffs", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const getPullRequestDiff = vi.fn(() =>
      Effect.succeed({ patch: "diff --git", truncated: false }),
    );
    const operations = makePullRequestOperations({
      github: { ...base, getPullRequestDiff },
      pins: {
        listByProjectIds: () => Effect.succeed([]),
        setPinned: () => Effect.void,
      },
      findProject: () => Effect.succeed(project),
      validateRepository: (repository) => Effect.succeed(repository),
      validateProjectRepository: (_project, repository) => Effect.succeed(repository),
      resolveGitHubCwd: () => Effect.succeed("/jj/git-store"),
      loadMergeCapabilities: () =>
        Effect.succeed({
          merge: true,
          squash: true,
          rebase: true,
          deleteBranchOnMerge: false,
        }),
      withGitHubRead: (effect) => effect,
      finalizeMutationCaches: () => Effect.void,
    });

    await Effect.runPromise(
      operations.diff({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
      }),
    );

    expect(getPullRequestDiff).toHaveBeenCalledWith({
      cwd: "/jj/git-store",
      repository: "acme/widgets",
      number: 42,
    });
  });

  it("starts detail, merge-capability, and review-comment reads together", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const detailStarted = yield* Deferred.make<void>();
          const capabilitiesStarted = yield* Deferred.make<void>();
          const commentsStarted = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const waitForRelease = <A>(started: Deferred.Deferred<void>, value: A) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return value;
            });
          const base = createGitHubCliWithFakeGh().service;
          const pins: ProjectPullRequestPinsShape = {
            listByProjectIds: () => Effect.succeed([]),
            setPinned: () => Effect.void,
          };
          const operations = makePullRequestOperations({
            github: {
              ...base,
              getPullRequestDetail: () => waitForRelease(detailStarted, detail),
              getPullRequestReviewComments: () =>
                waitForRelease(commentsStarted, { comments: [], truncated: false }),
            },
            pins,
            findProject: () => Effect.succeed(project),
            validateRepository: (repository) => Effect.succeed(repository),
            validateProjectRepository: (_project, repository) => Effect.succeed(repository),
            resolveGitHubCwd: () => Effect.succeed(project.workspaceRoot),
            loadMergeCapabilities: () =>
              waitForRelease(capabilitiesStarted, {
                merge: true,
                squash: true,
                rebase: true,
                deleteBranchOnMerge: false,
              }),
            withGitHubRead: (effect) => effect,
            finalizeMutationCaches: () => Effect.void,
          });

          const fiber = yield* operations
            .detail({ projectId: project.id, repository: "acme/widgets", number: 42 })
            .pipe(Effect.forkChild);
          yield* Effect.all([Deferred.await(detailStarted), Deferred.await(capabilitiesStarted)], {
            concurrency: 2,
          });
          yield* Effect.yieldNow;

          expect(yield* Deferred.isDone(commentsStarted)).toBe(true);
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(fiber)).number).toBe(42);
        }),
      ),
    );
  });

  it("fast-forwards the explicit PR repository and base branch to the reviewed head", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const getPullRequestDetail = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed(detail))
      .mockReturnValueOnce(
        Effect.succeed({ ...detail, state: "merged" as const, mergedAt: now }),
      );
    const fastForwardBranch = vi.fn(() => Effect.succeed({ oid: reviewedHeadOid }));
    const finalizeMutationCaches = vi.fn(() => Effect.void);
    const operations = makePullRequestOperations(
      makeDependencies(
        { ...base, getPullRequestDetail, fastForwardBranch },
        { finalizeMutationCaches },
      ),
    );

    const result = await Effect.runPromise(
      operations.action({
        projectId: project.id,
        repository: "acme/secondary",
        number: 42,
        action: "fast-forward",
        expectedHeadOid: reviewedHeadOid,
      }),
    );

    expect(fastForwardBranch).toHaveBeenCalledWith({
      cwd: project.workspaceRoot,
      repository: "acme/secondary",
      branch: "main",
      targetOid: reviewedHeadOid,
    });
    expect(result.fastForwardStatus).toBe("merged");
    expect(finalizeMutationCaches).toHaveBeenCalledWith("acme/secondary", 42, {
      invalidateReviewMatches: true,
    });
  });

  it("rejects fast-forward when the PR head changed after the rendered snapshot", async () => {
    const base = createGitHubCliWithFakeGh().service;
    const fastForwardBranch = vi.fn(() => Effect.succeed({ oid: reviewedHeadOid }));
    const operations = makePullRequestOperations(
      makeDependencies({
        ...base,
        getPullRequestDetail: () =>
          Effect.succeed({
            ...detail,
            headOid: "3333333333333333333333333333333333333333",
          }),
        fastForwardBranch,
      }),
    );

    await expect(
      Effect.runPromise(
        operations.action({
          projectId: project.id,
          repository: "acme/widgets",
          number: 42,
          action: "fast-forward",
          expectedHeadOid: reviewedHeadOid,
        }),
      ),
    ).rejects.toThrow("received new commits");
    expect(fastForwardBranch).not.toHaveBeenCalled();
  });

  it("acknowledges the ref update when the follow-up PR read is unavailable", async () => {
    const base = createGitHubCliWithFakeGh().service;
    let detailReadCount = 0;
    const getPullRequestDetail = vi.fn(() => {
      detailReadCount += 1;
      return detailReadCount === 1
        ? Effect.succeed(detail)
        : Effect.fail(
            new GitHubCliError({
              operation: "getPullRequestDetail",
              detail: "GitHub detail refresh failed.",
            }),
          );
    });
    const operations = makePullRequestOperations(
      makeDependencies({
        ...base,
        getPullRequestDetail,
        fastForwardBranch: () => Effect.succeed({ oid: reviewedHeadOid }),
      }),
    );

    const result = await Effect.runPromise(
      operations.action({
        projectId: project.id,
        repository: "acme/widgets",
        number: 42,
        action: "fast-forward",
        expectedHeadOid: reviewedHeadOid,
      }),
    );

    expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    expect(result.fastForwardStatus).toBe("base-updated");
  });
});
