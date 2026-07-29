// FILE: desktopRendererIpc.ts
// Purpose: Makes renderer-bound IPC safe across Electron teardown races.
// Layer: Desktop main process helper

import type { WebContents } from "electron";

export type DesktopRendererIpcTarget = Pick<WebContents, "isDestroyed" | "send">;

export function isDestroyedElectronObjectError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    error.message === "Object has been destroyed"
  );
}

// A BrowserWindow can survive just long enough for its WebContents to disappear.
// Renderer notifications are best-effort at that boundary; the recreated renderer
// reads its authoritative state through the normal IPC getters.
export function sendDesktopRendererIpc(
  target: DesktopRendererIpcTarget | null | undefined,
  channel: string,
  ...args: unknown[]
): boolean {
  if (!target) return false;

  try {
    if (target.isDestroyed()) return false;
    target.send(channel, ...args);
    return true;
  } catch (error) {
    if (isDestroyedElectronObjectError(error)) return false;
    throw error;
  }
}
