// FILE: desktopContextMenu.ts
// Purpose: Keeps the native edit menu off desktop surfaces that have no relevant actions.

import type { ContextMenuParams } from "electron";

export interface DesktopContextMenuContext {
  readonly isEditable: ContextMenuParams["isEditable"];
  readonly mediaType: ContextMenuParams["mediaType"];
  readonly misspelledWord: ContextMenuParams["misspelledWord"];
  readonly editFlags: Pick<
    ContextMenuParams["editFlags"],
    "canCopy" | "canCut" | "canPaste" | "canSelectAll"
  >;
}

export function shouldShowDesktopContextMenu(context: DesktopContextMenuContext): boolean {
  return (
    context.isEditable ||
    context.mediaType === "image" ||
    context.misspelledWord.length > 0 ||
    context.editFlags.canCut ||
    context.editFlags.canCopy ||
    context.editFlags.canPaste
  );
}
