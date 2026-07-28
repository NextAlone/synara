// FILE: desktopContextMenu.test.ts
// Purpose: Verifies that native edit menus only open for meaningful desktop contexts.

import { describe, expect, it } from "vitest";

import { type DesktopContextMenuContext, shouldShowDesktopContextMenu } from "./desktopContextMenu";

const blankContext = {
  isEditable: false,
  mediaType: "none",
  misspelledWord: "",
  editFlags: {
    canCut: false,
    canCopy: false,
    canPaste: false,
    canSelectAll: true,
  },
} satisfies DesktopContextMenuContext;

describe("shouldShowDesktopContextMenu", () => {
  it("hides the menu when only whole-page Select All is available", () => {
    expect(shouldShowDesktopContextMenu(blankContext)).toBe(false);
  });

  it.each([
    ["an editable field", { ...blankContext, isEditable: true }],
    [
      "a text selection",
      {
        ...blankContext,
        editFlags: { ...blankContext.editFlags, canCopy: true },
      },
    ],
    ["an image", { ...blankContext, mediaType: "image" as const }],
    ["a misspelled word", { ...blankContext, misspelledWord: "mispelled" }],
  ])("shows the menu for %s", (_label, context) => {
    expect(shouldShowDesktopContextMenu(context)).toBe(true);
  });
});
