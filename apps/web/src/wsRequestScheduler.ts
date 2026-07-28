// FILE: wsRequestScheduler.ts
// Purpose: Bounds expensive WebSocket reads before they reach server admission.
// Layer: Web transport

export type WsRequestPriority = "interactive" | "background";

interface QueuedRequest<A> {
  readonly priority: WsRequestPriority;
  readonly run: () => Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

export interface WsRequestSchedulerSnapshot {
  readonly active: number;
  readonly queuedInteractive: number;
  readonly queuedBackground: number;
}

export class WsRequestQueueCapacityError extends Error {
  readonly code = "WS_REQUEST_QUEUE_CAPACITY_EXCEEDED";

  constructor() {
    super("WebSocket expensive-read request queue capacity exceeded.");
    this.name = "WsRequestQueueCapacityError";
  }
}

export class WsQueuedRequestSupersededError extends Error {
  readonly code = "WS_BACKGROUND_REQUEST_SUPERSEDED";

  constructor() {
    super("Queued background WebSocket request was superseded by interactive work.");
    this.name = "WsQueuedRequestSupersededError";
  }
}

export class WsRequestScheduler {
  private active = 0;
  private disposed = false;
  private readonly queue: Array<QueuedRequest<unknown>> = [];

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued = 64,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new RangeError("WebSocket request scheduler concurrency must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued <= 0) {
      throw new RangeError("WebSocket request scheduler maxQueued must be a positive integer.");
    }
  }

  schedule<A>(
    run: () => Promise<A>,
    options?: {
      readonly priority?: WsRequestPriority;
      readonly signal?: AbortSignal;
    },
  ): Promise<A> {
    if (this.disposed) {
      return Promise.reject(new Error("WebSocket request scheduler disposed."));
    }
    if (options?.signal?.aborted) {
      return Promise.reject(options.signal.reason ?? new Error("WebSocket request was cancelled."));
    }

    return new Promise<A>((resolve, reject) => {
      const priority = options?.priority ?? "interactive";
      let queuedEntry: QueuedRequest<A>;
      const onAbort = () => {
        const index = this.queue.indexOf(queuedEntry as QueuedRequest<unknown>);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(options?.signal?.reason ?? new Error("WebSocket request was cancelled."));
      };
      queuedEntry = {
        priority,
        run,
        resolve,
        reject,
        signal: options?.signal,
        onAbort,
      };

      if (this.active < this.concurrency && this.queue.length === 0) {
        this.start(queuedEntry);
        return;
      }

      if (this.queue.length >= this.maxQueued) {
        if (priority === "interactive") {
          const backgroundIndex = this.queue.findLastIndex(
            (queued) => queued.priority === "background",
          );
          if (backgroundIndex >= 0) {
            const [superseded] = this.queue.splice(backgroundIndex, 1);
            if (superseded) {
              superseded.signal?.removeEventListener("abort", superseded.onAbort);
            }
            superseded?.reject(new WsQueuedRequestSupersededError());
          } else {
            reject(new WsRequestQueueCapacityError());
            return;
          }
        } else {
          reject(new WsRequestQueueCapacityError());
          return;
        }
      }

      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (priority === "interactive") {
        const firstBackground = this.queue.findIndex((queued) => queued.priority === "background");
        if (firstBackground >= 0) {
          this.queue.splice(firstBackground, 0, queuedEntry as QueuedRequest<unknown>);
        } else {
          this.queue.push(queuedEntry as QueuedRequest<unknown>);
        }
      } else {
        this.queue.push(queuedEntry as QueuedRequest<unknown>);
      }
    });
  }

  snapshot(): WsRequestSchedulerSnapshot {
    return {
      active: this.active,
      queuedInteractive: this.queue.filter((entry) => entry.priority === "interactive").length,
      queuedBackground: this.queue.filter((entry) => entry.priority === "background").length,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = this.queue.splice(0);
    for (const entry of queued) {
      entry.signal?.removeEventListener("abort", entry.onAbort);
      entry.reject(new Error("WebSocket request scheduler disposed."));
    }
  }

  private start<A>(entry: QueuedRequest<A>): void {
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (entry.signal?.aborted) {
      entry.reject(entry.signal.reason ?? new Error("WebSocket request was cancelled."));
      this.drain();
      return;
    }
    this.active += 1;
    void entry
      .run()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active -= 1;
        this.drain();
      });
  }

  private drain(): void {
    while (!this.disposed && this.active < this.concurrency) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.start(entry);
    }
  }
}
