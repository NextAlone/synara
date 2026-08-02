import "../../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NATIVE_BROWSER_OVERLAY_SYNC_EVENT } from "~/lib/nativeBrowserOverlay";
import {
  Menu,
  MenuItem,
  MenuPopupBase,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "./menu";

function OverlaySyncMenuFixture() {
  return (
    <Menu>
      <MenuTrigger>Open actions</MenuTrigger>
      <MenuPopupBase>
        <MenuItem>Close actions</MenuItem>
      </MenuPopupBase>
    </Menu>
  );
}

function HoverSubmenuFixture() {
  const [open, setOpen] = useState(true);
  const [closedReason, setClosedReason] = useState<string | null>(null);
  const anchor = {
    getBoundingClientRect: () => new DOMRect(24, 24, 0, 0),
  };

  if (!open) return <p>Menu closed: {closedReason}</p>;

  return (
    <Menu
      keepOpenOnSubmenuInteraction
      open
      onOpenChange={(nextOpen, eventDetails) => {
        setClosedReason(eventDetails.reason);
        setOpen(nextOpen);
      }}
    >
      <MenuPopupBase anchor={anchor} align="start" side="bottom">
        <MenuItem>Primary action</MenuItem>
        <MenuSub keepOpenOnFocusOut>
          <MenuSubTrigger>Move to space</MenuSubTrigger>
          <MenuSubPopup>
            <MenuItem>Void</MenuItem>
            <MenuItem>Work</MenuItem>
          </MenuSubPopup>
        </MenuSub>
      </MenuPopupBase>
    </Menu>
  );
}

describe("Menu submenu hover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays open while the pointer crosses from its trigger into the popup", async () => {
    const screen = await render(<HoverSubmenuFixture />);

    await page.getByText("Move to space", { exact: true }).hover();
    await expect.element(page.getByText("Void", { exact: true })).toBeVisible();

    await page.getByText("Void", { exact: true }).hover();
    await new Promise((resolve) => window.setTimeout(resolve, 220));

    await expect.element(page.getByText("Void", { exact: true })).toBeVisible();
    await screen.unmount();
  });

  it("still closes for an actual menu item selection", async () => {
    const screen = await render(<HoverSubmenuFixture />);

    await page.getByText("Primary action", { exact: true }).click();

    await expect.element(page.getByText("Menu closed: item-press", { exact: true })).toBeVisible();
    await screen.unmount();
  });

  it("announces popup geometry changes for native browser occlusion", async () => {
    let overlaySyncCount = 0;
    const handleOverlaySync = () => {
      overlaySyncCount += 1;
    };
    window.addEventListener(NATIVE_BROWSER_OVERLAY_SYNC_EVENT, handleOverlaySync);
    const screen = await render(<OverlaySyncMenuFixture />);

    try {
      await page.getByRole("button", { name: "Open actions" }).click();
      await expect.element(page.getByText("Close actions", { exact: true })).toBeVisible();
      await vi.waitFor(() => expect(overlaySyncCount).toBeGreaterThan(0));

      const openSyncCount = overlaySyncCount;
      await page.getByText("Close actions", { exact: true }).click();
      await vi.waitFor(() => {
        expect(document.querySelector('[data-slot="menu-popup"]')).toBeNull();
        expect(overlaySyncCount).toBeGreaterThan(openSyncCount);
      });
    } finally {
      window.removeEventListener(NATIVE_BROWSER_OVERLAY_SYNC_EVENT, handleOverlaySync);
      await screen.unmount();
    }
  });
});
