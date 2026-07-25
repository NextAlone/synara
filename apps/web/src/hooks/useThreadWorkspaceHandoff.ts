import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { VcsBackend } from "@synara/contracts";
import { resolveWorktreeHandoffIntent } from "@synara/shared/worktreeHandoff";
import { useCallback, useState } from "react";
import { vcsHandoffThreadMutationOptions } from "~/lib/vcsReactQuery";
import { buildSuggestedWorktreeName } from "../components/ChatView.logic";
import { toastManager } from "../components/ui/toast";
import { newCommandId } from "../lib/utils";
import {
  setupProjectScript,
  type ProjectScriptRunOptions,
  type ProjectScriptRunResult,
} from "../projectScripts";
import type { Project, ProjectScript, Thread } from "../types";

export function useThreadWorkspaceHandoff(input: {
  activeProject: Project | undefined;
  activeThread: Thread | undefined;
  vcsBackend: VcsBackend;
  activeRootBranch: string | null;
  activeThreadAssociatedWorktree: {
    associatedWorktreePath: string | null;
    associatedWorktreeBranch: string | null;
    associatedWorktreeRef: string | null;
  };
  isServerThread: boolean;
  stopActiveThreadSession: () => Promise<void>;
  runProjectScript: (
    script: ProjectScript,
    options?: ProjectScriptRunOptions,
  ) => Promise<ProjectScriptRunResult | null>;
}) {
  const queryClient = useQueryClient();
  const handoffThreadMutation = useMutation(
    vcsHandoffThreadMutationOptions({ queryClient }),
  );
  const [worktreeHandoffDialogOpen, setWorktreeHandoffDialogOpen] = useState(false);
  const [worktreeHandoffName, setWorktreeHandoffName] = useState("");

  // Manual memoization kept: this file does not compile under React Compiler (see compile-report).
  const handoffThread = useCallback(
    async (targetMode: "local" | "worktree", options?: { preferredWorktreeName?: string }) => {
      if (
        !input.activeProject ||
        !input.activeThread ||
        !input.isServerThread ||
        handoffThreadMutation.isPending
      ) {
        return false;
      }

      try {
        await input.stopActiveThreadSession();
        const vcs = input.activeProject.vcs;
        if (!vcs?.binding || vcs.binding.backend !== input.vcsBackend) {
          throw new Error(
            `This project is not configured for the global ${input.vcsBackend === "jj" ? "JJ" : "Git"} backend yet.`,
          );
        }
        const result = await handoffThreadMutation.mutateAsync({
          commandId: newCommandId(),
          projectId: input.activeProject.id,
          threadId: input.activeThread.id,
          expectedEpoch: vcs.epoch,
          targetMode: targetMode === "worktree" ? "workspace" : "local",
          preferredLocalReference: input.activeRootBranch ?? input.activeThread.branch ?? null,
          preferredWorkspaceBaseReference:
            input.activeRootBranch ??
            input.activeThreadAssociatedWorktree.associatedWorktreeBranch ??
            input.activeThread.branch ??
            null,
          preferredNewWorkspaceName: options?.preferredWorktreeName ?? null,
        });

        if (targetMode === "worktree" && result.workspacePath) {
          const setupScript = setupProjectScript(input.activeProject.scripts);
          if (setupScript) {
            await input.runProjectScript(setupScript, {
              cwd: result.workspacePath,
              worktreePath: result.workspacePath,
              rememberAsLastInvoked: false,
            });
          }
        }

        toastManager.add({
          type: result.conflictsDetected ? "warning" : "success",
          title:
            targetMode === "worktree"
              ? "Thread handed off to workspace"
              : "Thread handed off to local",
          ...(result.message ? { description: result.message } : {}),
        });
        return true;
      } catch (error) {
        toastManager.add({
          type: "error",
          title:
            targetMode === "worktree"
              ? "Could not hand off to workspace"
              : "Could not hand off to local",
          description:
            error instanceof Error ? error.message : "An error occurred during the handoff.",
        });
        return false;
      }
    },
    [handoffThreadMutation, input],
  );

  const onHandoffToWorktree = useCallback(() => {
    if (!input.activeThread) {
      return;
    }

    const worktreeIntent = resolveWorktreeHandoffIntent({
      associatedWorktreePath: input.activeThreadAssociatedWorktree.associatedWorktreePath,
      associatedWorktreeBranch: input.activeThreadAssociatedWorktree.associatedWorktreeBranch,
      associatedWorktreeRef: input.activeThreadAssociatedWorktree.associatedWorktreeRef,
      preferredWorktreeBaseBranch: input.activeRootBranch,
      currentBranch: input.activeThread.branch ?? null,
    });
    if (worktreeIntent?.kind === "reuse-associated") {
      void handoffThread("worktree");
      return;
    }

    setWorktreeHandoffName(
      buildSuggestedWorktreeName({
        associatedWorktreeBranch:
          input.activeThreadAssociatedWorktree.associatedWorktreeBranch ??
          input.activeThread.branch ??
          null,
        title: input.activeThread.title,
      }),
    );
    setWorktreeHandoffDialogOpen(true);
  }, [handoffThread, input]);

  const confirmWorktreeHandoff = useCallback(async () => {
    const normalizedWorktreeName = buildSuggestedWorktreeName({
      associatedWorktreeBranch: worktreeHandoffName,
    });
    setWorktreeHandoffName(normalizedWorktreeName);
    const succeeded = await handoffThread("worktree", {
      preferredWorktreeName: normalizedWorktreeName,
    });
    if (succeeded) {
      setWorktreeHandoffDialogOpen(false);
    }
  }, [handoffThread, worktreeHandoffName]);

  const onHandoffToLocal = useCallback(async () => {
    await handoffThread("local");
  }, [handoffThread]);

  return {
    handoffBusy: handoffThreadMutation.isPending,
    worktreeHandoffDialogOpen,
    setWorktreeHandoffDialogOpen,
    worktreeHandoffName,
    setWorktreeHandoffName,
    onHandoffToWorktree,
    onHandoffToLocal,
    confirmWorktreeHandoff,
  };
}
