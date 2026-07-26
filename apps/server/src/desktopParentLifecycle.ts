import { Effect } from "effect";

export const DESKTOP_PARENT_IPC_ENV_KEY = "SYNARA_DESKTOP_PARENT_IPC";

export interface DesktopParentConnection {
  readonly connected?: boolean;
  once(event: "disconnect", listener: () => void): unknown;
  off(event: "disconnect", listener: () => void): unknown;
}

export function consumeDesktopParentIpcFlag(env: NodeJS.ProcessEnv): boolean {
  const enabled = env[DESKTOP_PARENT_IPC_ENV_KEY] === "1";
  delete env[DESKTOP_PARENT_IPC_ENV_KEY];
  return enabled;
}

export function waitForDesktopParentDisconnect(input: {
  readonly enabled: boolean;
  readonly parent: DesktopParentConnection;
}): Effect.Effect<void> {
  if (!input.enabled) {
    return Effect.never;
  }
  if (input.parent.connected !== true) {
    return Effect.void;
  }

  return Effect.callback<void>((resume) => {
    let completed = false;
    const handleDisconnect = () => {
      if (completed) return;
      completed = true;
      resume(Effect.void);
    };

    input.parent.once("disconnect", handleDisconnect);
    // Close the race where the IPC channel disappears between the initial
    // connected check and listener registration.
    if (input.parent.connected !== true) {
      queueMicrotask(handleDisconnect);
    }

    return Effect.sync(() => {
      input.parent.off("disconnect", handleDisconnect);
    });
  });
}

export function protectFromDesktopParentExit<A, E, R>(input: {
  readonly program: Effect.Effect<A, E, R>;
  readonly enabled: boolean;
  readonly parent: DesktopParentConnection;
  readonly onDisconnect: Effect.Effect<void>;
}): Effect.Effect<A | void, E, R> {
  const parentDisconnect = waitForDesktopParentDisconnect(input).pipe(
    Effect.tap(() => input.onDisconnect),
  );
  return Effect.raceFirst(input.program, parentDisconnect);
}
