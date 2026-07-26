import { EventEmitter } from "node:events";

import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import {
  consumeDesktopParentIpcFlag,
  DESKTOP_PARENT_IPC_ENV_KEY,
  protectFromDesktopParentExit,
  waitForDesktopParentDisconnect,
  type DesktopParentConnection,
} from "./desktopParentLifecycle";

class FakeParentConnection extends EventEmitter implements DesktopParentConnection {
  connected = true;

  disconnect(): void {
    this.connected = false;
    this.emit("disconnect");
  }
}

describe("desktop parent lifecycle", () => {
  it("consumes the explicit desktop IPC marker", () => {
    const enabledEnv: NodeJS.ProcessEnv = { [DESKTOP_PARENT_IPC_ENV_KEY]: "1" };
    const disabledEnv: NodeJS.ProcessEnv = { [DESKTOP_PARENT_IPC_ENV_KEY]: "true" };

    expect(consumeDesktopParentIpcFlag(enabledEnv)).toBe(true);
    expect(enabledEnv[DESKTOP_PARENT_IPC_ENV_KEY]).toBeUndefined();
    expect(consumeDesktopParentIpcFlag(disabledEnv)).toBe(false);
    expect(disabledEnv[DESKTOP_PARENT_IPC_ENV_KEY]).toBeUndefined();
  });

  it("completes when an enabled parent IPC channel disconnects", async () => {
    const parent = new FakeParentConnection();
    const fiber = Effect.runFork(waitForDesktopParentDisconnect({ enabled: true, parent }));

    parent.disconnect();

    await Effect.runPromise(Fiber.join(fiber));
    expect(parent.listenerCount("disconnect")).toBe(0);
  });

  it("completes immediately when the marked parent already disconnected", async () => {
    const parent = new FakeParentConnection();
    parent.connected = false;

    await expect(
      Effect.runPromise(waitForDesktopParentDisconnect({ enabled: true, parent })),
    ).resolves.toBeUndefined();
  });

  it("interrupts the server program and runs disconnect cleanup", async () => {
    const parent = new FakeParentConnection();
    const events: string[] = [];
    const protectedProgram = protectFromDesktopParentExit({
      program: Effect.never.pipe(
        Effect.ensuring(Effect.sync(() => events.push("program-finalized"))),
      ),
      enabled: true,
      parent,
      onDisconnect: Effect.sync(() => events.push("disconnect-observed")),
    });
    const fiber = Effect.runFork(protectedProgram);

    parent.disconnect();
    await Effect.runPromise(Fiber.join(fiber));

    expect(events).toEqual(["disconnect-observed", "program-finalized"]);
    expect(parent.listenerCount("disconnect")).toBe(0);
  });

  it("leaves an unmarked server program independent from parent events", async () => {
    const parent = new FakeParentConnection();
    const protectedProgram = protectFromDesktopParentExit({
      program: Effect.succeed("completed"),
      enabled: false,
      parent,
      onDisconnect: Effect.die("must not run"),
    });

    await expect(Effect.runPromise(protectedProgram)).resolves.toBe("completed");
    expect(parent.listenerCount("disconnect")).toBe(0);
  });
});
