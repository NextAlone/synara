import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerUpdateContinuationPanel } from "./ComposerUpdateContinuationPanel";
import { ComposerColumnFrame } from "./ComposerColumnFrame";

describe("ComposerUpdateContinuationPanel", () => {
  it("offers an explicit continuation and dismissal", async () => {
    const onContinue = vi.fn();
    const onDismiss = vi.fn();
    await render(
      <div className="w-full max-w-[520px] p-4">
        <ComposerColumnFrame>
          <ComposerUpdateContinuationPanel
            continuing={false}
            onContinue={onContinue}
            onDismiss={onDismiss}
          />
        </ComposerColumnFrame>
      </div>,
    );

    await expect.element(page.getByText("Interrupted by update")).toBeVisible();
    await page.getByRole("button", { name: "Continue interrupted task" }).click();
    await page.getByRole("button", { name: "Dismiss interrupted task" }).click();
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
