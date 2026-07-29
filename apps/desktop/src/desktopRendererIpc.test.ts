import { describe, expect, it, vi } from "vitest";

import {
  isDestroyedElectronObjectError,
  sendDesktopRendererIpc,
  type DesktopRendererIpcTarget,
} from "./desktopRendererIpc";

function makeTarget(overrides: Partial<DesktopRendererIpcTarget> = {}): DesktopRendererIpcTarget {
  return {
    isDestroyed: () => false,
    send: vi.fn(),
    ...overrides,
  } as DesktopRendererIpcTarget;
}

describe("sendDesktopRendererIpc", () => {
  it("does not send to a renderer that has already been destroyed", () => {
    const send = vi.fn();
    const target = makeTarget({ isDestroyed: () => true, send });

    expect(sendDesktopRendererIpc(target, "desktop:state", { ready: true })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("tolerates a renderer teardown race during send", () => {
    const target = makeTarget({
      send: () => {
        throw new Error("Object has been destroyed");
      },
    });

    expect(sendDesktopRendererIpc(target, "desktop:state")).toBe(false);
  });

  it("preserves unrelated IPC errors", () => {
    const target = makeTarget({
      send: () => {
        throw new Error("IPC serialization failed");
      },
    });

    expect(() => sendDesktopRendererIpc(target, "desktop:state")).toThrow(
      "IPC serialization failed",
    );
  });
});

describe("isDestroyedElectronObjectError", () => {
  it("only classifies Electron's destroyed-object error", () => {
    expect(isDestroyedElectronObjectError(new Error("Object has been destroyed"))).toBe(true);
    expect(isDestroyedElectronObjectError(new Error("renderer crashed"))).toBe(false);
  });
});
