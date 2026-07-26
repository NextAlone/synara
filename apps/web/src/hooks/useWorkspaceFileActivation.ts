// FILE: useWorkspaceFileActivation.ts
// Purpose: Route workspace file clicks to the in-app preview or the native file
//          manager after the shared read query classifies unsupported binaries.
// Layer: Web interaction hook shared by explorer rows and chat file references.

import { isLocalAbsolutePath } from "@synara/shared/path";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";
import { activateWorkspaceFile } from "~/lib/workspaceFileOpener";
import { readNativeApi } from "~/nativeApi";

export function useWorkspaceFileActivation(workspaceRoot: string | null) {
  const queryClient = useQueryClient();
  const latestActivationRef = useRef(0);

  useEffect(
    () => () => {
      latestActivationRef.current += 1;
    },
    [],
  );

  return (filePath: string, preview: () => void) => {
    if (!workspaceRoot && !isLocalAbsolutePath(filePath)) {
      preview();
      return;
    }

    const activation = latestActivationRef.current + 1;
    latestActivationRef.current = activation;
    void activateWorkspaceFile({
      queryClient,
      workspaceRoot,
      filePath,
      preview: () => {
        if (latestActivationRef.current === activation) {
          preview();
        }
      },
      reveal: async (absolutePath) => {
        if (latestActivationRef.current !== activation) {
          return;
        }
        const api = readNativeApi();
        if (!api) {
          throw new Error("Native API not found.");
        }
        await api.shell.showInFolder(absolutePath);
      },
    }).catch((error: unknown) => {
      if (latestActivationRef.current !== activation) {
        return;
      }
      toastManager.add({
        type: "error",
        title: "Unable to reveal file",
        description: error instanceof Error ? error.message : "The file could not be revealed.",
      });
    });
  };
}
