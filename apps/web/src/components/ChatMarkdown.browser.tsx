// FILE: ChatMarkdown.browser.tsx
// Purpose: Browser regression coverage for Mermaid Markdown rendering.
// Layer: Web chat markdown browser test

import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown Mermaid fences", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a Mermaid fence to SVG after the client-side renderer loads", async () => {
    const screen = await render(
      <ChatMarkdown
        text={["```mermaid", "flowchart LR", "  Start --> Finish", "```"].join("\n")}
        cwd="/workspace"
        isStreaming={false}
      />,
    );

    await vi.waitFor(() => {
      expect(document.querySelector(".chat-markdown-mermaid > svg")).not.toBeNull();
    });

    const diagram = document.querySelector(".chat-markdown-mermaid > svg");
    expect(diagram?.querySelector("script")).toBeNull();
    expect(document.querySelector("[data-mermaid-source]")).toBeNull();
    await screen.unmount();
  });
});
