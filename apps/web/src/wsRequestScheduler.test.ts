import { describe, expect, it, vi } from "vitest";

import {
  WsQueuedRequestSupersededError,
  WsRequestQueueCapacityError,
  WsRequestScheduler,
} from "./wsRequestScheduler";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WsRequestScheduler", () => {
  it("never runs more than the configured expensive-read concurrency", async () => {
    const scheduler = new WsRequestScheduler(2);
    const gates = [deferred(), deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const calls = gates.map((gate) =>
      scheduler.schedule(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
      }),
    );

    await Promise.resolve();
    expect(scheduler.snapshot()).toEqual({
      active: 2,
      queuedInteractive: 1,
      queuedBackground: 0,
    });
    gates[0]?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(peak).toBe(2);
    gates[1]?.resolve();
    gates[2]?.resolve();
    await Promise.all(calls);
  });

  it("runs queued interactive work before background work", async () => {
    const scheduler = new WsRequestScheduler(1);
    const gate = deferred();
    const order: string[] = [];
    const active = scheduler.schedule(async () => {
      await gate.promise;
      order.push("active");
    });
    const background = scheduler.schedule(
      async () => {
        order.push("background");
      },
      { priority: "background" },
    );
    const interactive = scheduler.schedule(async () => {
      order.push("interactive");
    });

    gate.resolve();
    await Promise.all([active, background, interactive]);
    expect(order).toEqual(["active", "interactive", "background"]);
  });

  it("drops a queued background request when interactive work needs the bounded slot", async () => {
    const scheduler = new WsRequestScheduler(1, 1);
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise);
    const backgroundRun = vi.fn(async () => undefined);
    const background = scheduler.schedule(backgroundRun, { priority: "background" });
    const interactive = scheduler.schedule(async () => "interactive");

    await expect(background).rejects.toBeInstanceOf(WsQueuedRequestSupersededError);
    gate.resolve();
    await expect(active).resolves.toBeUndefined();
    await expect(interactive).resolves.toBe("interactive");
    expect(backgroundRun).not.toHaveBeenCalled();
  });

  it("removes an aborted queued request without consuming capacity", async () => {
    const scheduler = new WsRequestScheduler(1);
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise);
    const controller = new AbortController();
    const queuedRun = vi.fn(async () => undefined);
    const queued = scheduler.schedule(queuedRun, { signal: controller.signal });

    controller.abort(new Error("stale query"));
    await expect(queued).rejects.toThrow("stale query");
    expect(scheduler.snapshot().queuedInteractive).toBe(0);
    gate.resolve();
    await active;
    expect(queuedRun).not.toHaveBeenCalled();
  });

  it("rejects excess background work instead of growing without bound", async () => {
    const scheduler = new WsRequestScheduler(1, 1);
    const gate = deferred();
    const active = scheduler.schedule(() => gate.promise);
    const queued = scheduler.schedule(async () => undefined, { priority: "background" });

    await expect(
      scheduler.schedule(async () => undefined, { priority: "background" }),
    ).rejects.toBeInstanceOf(WsRequestQueueCapacityError);
    gate.resolve();
    await Promise.all([active, queued]);
  });
});
