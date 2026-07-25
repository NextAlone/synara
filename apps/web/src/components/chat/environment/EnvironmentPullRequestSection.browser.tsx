// FILE: EnvironmentPullRequestSection.browser.tsx
// Purpose: Browser regression tests for PR actions in the Environment panel.
// Layer: Vitest browser tests

import "../../../index.css";

import {
  ProjectId,
  ThreadId,
  type VcsPullRequestSnapshotResult,
  type VcsPullRequestStatus,
  type VcsStatusResult,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import {
  type VcsQueryTarget,
  vcsPullRequestSnapshotQueryOptions,
  vcsQueryKeys,
} from "~/lib/vcsReactQuery";
import { EnvironmentPullRequestSection } from "./EnvironmentPullRequestSection";

const projectId = ProjectId.makeUnsafe("project-pr-fix-actions");
const threadId = ThreadId.makeUnsafe("thread-pr-fix-actions");
const vcsTarget = {
  projectId,
  threadId: null,
  epoch: 1,
  backend: "git",
} satisfies VcsQueryTarget;
const pullRequest = {
  number: 321,
  title: "Keep PR context visible",
  url: "https://github.com/example/synara/pull/321",
  baseBranch: "main",
  headBranch: "fix/pr-panel",
  state: "open",
  isDraft: false,
  mergeability: "conflicting",
  additions: 4,
  deletions: 2,
  changedFiles: 1,
} satisfies VcsPullRequestStatus;

// Seeds both cached queries so the component renders without calling the native API.
function createQueryClient() {
  const queryClient = new QueryClient();
  const vcsStatus = {
    backend: "git",
    epoch: 1,
    ref: pullRequest.headBranch,
    revision: null,
    hasChanges: false,
    hasConflicts: false,
    files: [],
    insertions: 0,
    deletions: 0,
    remote: {
      ref: `origin/${pullRequest.headBranch}`,
      aheadCount: 0,
      behindCount: 0,
    },
    nearestBookmarkDistance: null,
    pullRequest,
    capabilities: {
      staging: true,
      stash: true,
      checkout: true,
      workspaces: true,
    },
  } satisfies VcsStatusResult;
  const snapshot = {
    backend: "git",
    epoch: 1,
    pullRequest,
    checks: [],
    comments: [
      {
        id: "comment-1",
        author: "reviewer",
        body: "Preserve the Environment panel while drafting the fix.",
        path: "EnvironmentPullRequestSection.tsx",
        url: `${pullRequest.url}#discussion_r1`,
        createdAt: "2026-07-09T10:00:00Z",
      },
      {
        id: "comment-2",
        author: "reviewer",
        body: "Address the second review finding too.",
        path: "OtherFile.tsx",
        url: `${pullRequest.url}#discussion_r2`,
        createdAt: "2026-07-09T10:01:00Z",
      },
    ],
    commentsTruncated: false,
    commentsError: null,
  } satisfies VcsPullRequestSnapshotResult;

  queryClient.setQueryData(vcsQueryKeys.status(vcsTarget), vcsStatus);
  queryClient.setQueryData(
    vcsPullRequestSnapshotQueryOptions({
      target: vcsTarget,
      reference: pullRequest.url,
      enabled: true,
    }).queryKey,
    snapshot,
  );
  return queryClient;
}

describe("EnvironmentPullRequestSection", () => {
  afterEach(() => {
    useComposerDraftStore.getState().clearDraftThread(threadId);
    document.body.innerHTML = "";
  });

  it("groups all review comments into one prompt and keeps the panel open", async () => {
    const onClose = vi.fn();
    const queryClient = createQueryClient();
    await render(
      <QueryClientProvider client={queryClient}>
        <EnvironmentPullRequestSection
          vcsTarget={vcsTarget}
          enabled
          activeThreadId={threadId}
          projectId={null}
          configuredRepositories={[{ nameWithOwner: "example/synara" }]}
          onOpenUrl={vi.fn()}
          onClose={onClose}
        />
      </QueryClientProvider>,
    );

    document
      .querySelector<HTMLButtonElement>('button[title*="resolve the merge conflicts"]')
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        'button[title="Draft one prompt containing all visible review comments"]',
      )
      ?.click();

    const prompt = useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt ?? "";
    expect(prompt).toContain("has merge conflicts with its base branch");
    expect(prompt).toContain("Preserve the Environment panel while drafting the fix.");
    expect(prompt).toContain("Address the second review finding too.");
    expect(onClose).not.toHaveBeenCalled();
  });
});
