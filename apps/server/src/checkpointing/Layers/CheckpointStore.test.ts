// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { CheckpointRef } from "@synara/contracts";
import { JjCoreLive } from "../../vcs/Layers/JjCore.ts";
import { JjCore, type JjCoreShape } from "../../vcs/Services/JjCore.ts";
import { jjCheckpointBookmark } from "../../vcs/checkpointBookmarks.ts";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          backend: "git" as const,
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() => execute.mock.calls.some(([call]) => call.args.join(" ") === "add -A -- .")),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(([call]) => call.args.join(" ") === "add -A -- ."),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          backend: "git" as const,
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "add -A -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "write-tree") {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith("commit-tree ")) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          backend: "git",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          backend: "git",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs("add -A -- .")).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (args === "diff --name-only --no-renames -z from-oid to-oid") {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            backend: "git",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });

  it("copies a JJ checkpoint ref without taking another filesystem snapshot", async () => {
    const fromCheckpointRef = CheckpointRef.makeUnsafe(
      "refs/synara-checkpoints/thread/jj-message-start",
    );
    const toCheckpointRef = CheckpointRef.makeUnsafe(
      "refs/synara-checkpoints/thread/jj-turn-start",
    );
    const execute = vi.fn<JjCoreShape["execute"]>((input) =>
      Effect.succeed({
        code: 0,
        stdout:
          input.operation === "CheckpointStore.resolveJjCheckpointRevision"
            ? "checkpoint-commit\n"
            : "",
        stderr: "",
      }),
    );
    const jj = {
      execute,
      withMutation: <A, E, R>(_cwd: string, effect: Effect.Effect<A, E, R>) => effect,
    } as unknown as JjCoreShape;
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(
        Layer.succeed(GitCore, {
          execute: () => Effect.die("unexpected Git call"),
        } as unknown as GitCoreShape),
      ),
      Layer.provide(Layer.succeed(JjCore, jj)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const copied = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.copyCheckpointRef({
          cwd: "/repo",
          backend: "jj",
          fromCheckpointRef,
          toCheckpointRef,
        });
      }),
    );

    expect(copied).toBe(true);
    expect(
      execute.mock.calls
        .map(([input]) => input)
        .find((input) => input.operation === "CheckpointStore.copyCheckpointRef.jj")?.args,
    ).toEqual([
      "bookmark",
      "set",
      "--allow-backwards",
      "--revision",
      "checkpoint-commit",
      jjCheckpointBookmark(toCheckpointRef),
    ]);
    expect(
      execute.mock.calls.some(
        ([input]) =>
          input.operation === "CheckpointStore.captureCheckpoint.jjSnapshot" ||
          input.operation === "CheckpointStore.captureCheckpoint.jjDuplicate",
      ),
    ).toBe(false);
  });

  it("captures a JJ checkpoint without advancing the working copy", async () => {
    const checkpointRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/jj-message");
    const execute = vi.fn<JjCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const readRevisionIdentity = vi.fn<JjCoreShape["readRevisionIdentity"]>((_cwd, revision) =>
      Effect.succeed({
        changeId: "checkpoint-change",
        commitId: "checkpoint-commit",
        description: revision ?? "",
      }),
    );
    const jj = {
      execute,
      readRevisionIdentity,
      withMutation: <A, E, R>(_cwd: string, effect: Effect.Effect<A, E, R>) => effect,
    } as unknown as JjCoreShape;
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(
        Layer.succeed(GitCore, {
          execute: () => Effect.die("unexpected Git call"),
        } as unknown as GitCoreShape),
      ),
      Layer.provide(Layer.succeed(JjCore, jj)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* store.captureCheckpoint({
          cwd: "/repo",
          backend: "jj",
          checkpointRef,
        });
      }),
    );

    const duplicate = execute.mock.calls
      .map(([input]) => input)
      .find((input) => input.operation === "CheckpointStore.captureCheckpoint.jjDuplicate");
    expect(duplicate?.args[0]).toBe("--config");
    expect(duplicate?.args[1]).toContain("templates.duplicate_description=");
    expect(duplicate?.args.slice(2)).toEqual(["duplicate", "@"]);
    expect(execute.mock.calls.some(([input]) => input.args.includes("new"))).toBe(false);
    expect(readRevisionIdentity).toHaveBeenCalledWith(
      "/repo",
      expect.stringContaining("description(substring:"),
    );
    expect(
      execute.mock.calls
        .map(([input]) => input)
        .find((input) => input.operation === "CheckpointStore.captureCheckpoint.jjAnchor")?.args,
    ).toEqual([
      "bookmark",
      "set",
      "--allow-backwards",
      "--revision",
      "checkpoint-commit",
      jjCheckpointBookmark(checkpointRef),
    ]);
  });

  it("reverses a JJ checkpoint only when touched paths still match the turn end", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/jj-turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/jj-turn/end");
    const execute = vi.fn<JjCoreShape["execute"]>((input) => {
      if (input.operation === "CheckpointStore.resolveJjCheckpointRevision") {
        const bookmark = input.args.join(" ");
        return Effect.succeed({
          code: 0,
          stdout: bookmark.includes(jjCheckpointBookmark(fromRef))
            ? "from-commit\n"
            : "to-commit\n",
          stderr: "",
        });
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    });
    const readRangeDiff = vi.fn<JjCoreShape["readRangeDiff"]>(() =>
      Effect.succeed({
        patch: "",
        files: [
          {
            status: "renamed",
            path: "src/new.ts",
            sourcePath: "src/old.ts",
            targetPath: "src/new.ts",
            conflicted: false,
          },
        ],
      }),
    );
    const jj = {
      execute,
      readRangeDiff,
      withMutation: <A, E, R>(_cwd: string, effect: Effect.Effect<A, E, R>) => effect,
    } as unknown as JjCoreShape;
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(
        Layer.succeed(GitCore, {
          execute: () => Effect.die("unexpected Git call"),
        } as unknown as GitCoreShape),
      ),
      Layer.provide(Layer.succeed(JjCore, jj)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.reverseCheckpointDiff({
          cwd: "/repo",
          backend: "jj",
          fromCheckpointRef: fromRef,
          toCheckpointRef: toRef,
        });
      }),
    );

    expect(result).toBe(true);
    expect(readRangeDiff).toHaveBeenCalledWith("/repo", "from-commit", "to-commit");
    expect(
      execute.mock.calls
        .map(([input]) => input)
        .find(
          (input) => input.operation === "CheckpointStore.reverseCheckpointDiff.jjVerifyCurrent",
        )?.args,
    ).toEqual([
      "--ignore-working-copy",
      "diff",
      "--from",
      "to-commit",
      "--to",
      "@",
      "--summary",
      "--",
      "src/old.ts",
      "src/new.ts",
    ]);
    expect(
      execute.mock.calls
        .map(([input]) => input)
        .find((input) => input.operation === "CheckpointStore.reverseCheckpointDiff.jj")?.args,
    ).toEqual([
      "restore",
      "--from",
      "from-commit",
      "--into",
      "@",
      "--",
      "src/old.ts",
      "src/new.ts",
    ]);
  });
});
