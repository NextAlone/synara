import { describe, expect, it } from "vitest";

import { sendBrowserState } from "./browserIpc";

describe("sendBrowserState", () => {
  it("does not let a destroyed renderer escape a browser-state subscription", () => {
    const webContents = {
      isDestroyed: () => false,
      send: () => {
        throw new Error("Object has been destroyed");
      },
    };

    expect(() => sendBrowserState(webContents as never, {} as never)).not.toThrow();
  });
});
