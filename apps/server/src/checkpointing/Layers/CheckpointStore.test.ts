// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { JjCommandError } from "../../vcs/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";

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
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
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
      Layer.provide(SqlitePersistenceMemory),
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

  it("seeds a capture from the working index so Git can reuse its stat cache", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "synara-checkpoint-index-test-"));
    const workingIndexPath = join(tempDir, "index");
    writeFileSync(workingIndexPath, "working-index-stat-cache");
    let capturedSeed = "";

    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: `${workingIndexPath}\n`, stderr: "" });
      }
      if (args === "add -A -- .") {
        capturedSeed = readFileSync(input.env?.GIT_INDEX_FILE ?? "", "utf8");
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
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.captureCheckpoint({
            cwd: tempDir,
            backend: "git",
            checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/stat-cache"),
          });
        }),
      );

      expect(capturedSeed).toBe("working-index-stat-cache");
      expect(
        execute.mock.calls.some(([call]) => call.args.join(" ") === "rev-parse --verify HEAD"),
      ).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
      }
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
      Layer.provide(SqlitePersistenceMemory),
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
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: "/repo/.git/index\n", stderr: "" });
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
      Layer.provide(SqlitePersistenceMemory),
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
      Layer.provide(SqlitePersistenceMemory),
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
    const execute = vi.fn<JjCoreShape["execute"]>((input) => {
      if (
        input.operation === "CheckpointStore.resolveJjCheckpointRevision" ||
        input.operation === "CheckpointStore.resolveJjSnapshotRevision"
      ) {
        return Effect.succeed({ code: 0, stdout: "checkpoint-commit\n", stderr: "" });
      }
      if (input.operation === "CheckpointStore.readJjTreeId") {
        return Effect.succeed({ code: 0, stdout: "checkpoint-tree\n", stderr: "" });
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    });
    const jj = {
      execute,
      detectRepository: (cwd: string) =>
        Effect.succeed({
          workspaceRoot: cwd,
          repositoryStorePath: cwd,
          gitStorePath: null,
        }),
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
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const copied = yield* store.copyCheckpointRef({
          cwd: "/repo",
          backend: "jj",
          fromCheckpointRef,
          toCheckpointRef,
        });
        const targetExists = yield* store.hasCheckpointRef({
          cwd: "/repo",
          backend: "jj",
          checkpointRef: toCheckpointRef,
        });
        return { copied, targetExists };
      }),
    );

    expect(result).toEqual({ copied: true, targetExists: true });
    expect(
      execute.mock.calls.some(
        ([input]) =>
          input.operation === "CheckpointStore.copyCheckpointRef.jj" ||
          input.args.includes(jjCheckpointBookmark(toCheckpointRef)),
      ),
    ).toBe(false);
    expect(
      execute.mock.calls.some(
        ([input]) =>
          input.operation === "CheckpointStore.captureCheckpoint.jjSnapshot" ||
          input.operation === "CheckpointStore.captureCheckpoint.jjDuplicate",
      ),
    ).toBe(false);
  });

  it("deduplicates JJ snapshots by tree and retries cleanup after the last alias", async () => {
    const firstRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/jj-message");
    const secondRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/jj-turn");
    const firstCwd = "/repo/workspace-a";
    const secondCwd = "/repo/workspace-b";
    let physicalAnchor: string | null = null;
    let physicalRevisionPresent = true;
    let failCleanupOnce = true;
    const execute = vi.fn<JjCoreShape["execute"]>((input) => {
      if (input.operation === "CheckpointStore.readJjTreeId") {
        return Effect.succeed({ code: 0, stdout: "shared-tree\n", stderr: "" });
      }
      if (input.operation === "CheckpointStore.resolveJjSnapshotRevision") {
        return Effect.succeed({
          code: physicalAnchor && physicalRevisionPresent ? 0 : 1,
          stdout: physicalAnchor && physicalRevisionPresent ? "checkpoint-commit\n" : "",
          stderr: "",
        });
      }
      if (input.operation === "CheckpointStore.captureCheckpoint.jjAnchor") {
        physicalAnchor = input.args.at(-1) ?? null;
      }
      if (input.operation === "CheckpointStore.cleanupJjSnapshotBookmark") {
        if (failCleanupOnce) {
          failCleanupOnce = false;
          return Effect.fail(
            new JjCommandError({
              operation: input.operation,
              command: "jj bookmark delete",
              cwd: input.cwd,
              detail: "simulated cleanup failure",
            }),
          );
        }
        physicalAnchor = null;
      }
      if (input.operation === "CheckpointStore.cleanupJjSnapshotRemainingBookmarks") {
        return Effect.succeed({
          code: 0,
          stdout: physicalAnchor ? `${physicalAnchor}\n` : "",
          stderr: "",
        });
      }
      if (input.operation === "CheckpointStore.cleanupJjSnapshotRevision") {
        physicalRevisionPresent = false;
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    });
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
      detectRepository: (cwd: string) =>
        Effect.succeed({
          workspaceRoot: cwd,
          repositoryStorePath: "/repo/.jj/repo",
          gitStorePath: "/repo/.git",
        }),
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
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        expect(yield* store.isRepository({ cwd: firstCwd, backend: "jj" })).toBe(true);
        expect(yield* store.isRepository({ cwd: secondCwd, backend: "jj" })).toBe(true);
        yield* store.captureCheckpoint({
          cwd: firstCwd,
          backend: "jj",
          checkpointRef: firstRef,
        });
        yield* store.captureCheckpoint({
          cwd: secondCwd,
          backend: "jj",
          checkpointRef: secondRef,
        });
        yield* store.deleteCheckpointRefs({
          cwd: firstCwd,
          backend: "jj",
          checkpointRefs: [firstRef],
        });
        expect(physicalAnchor).not.toBeNull();
        yield* store.deleteCheckpointRefs({
          cwd: secondCwd,
          backend: "jj",
          checkpointRefs: [secondRef],
        });
        expect(physicalAnchor).not.toBeNull();
        yield* store.deleteCheckpointRefs({
          cwd: secondCwd,
          backend: "jj",
          checkpointRefs: [secondRef],
        });
      }),
    );

    const duplicateCalls = execute.mock.calls
      .map(([input]) => input)
      .filter((input) => input.operation === "CheckpointStore.captureCheckpoint.jjDuplicate");
    expect(duplicateCalls).toHaveLength(1);
    const duplicate = duplicateCalls[0];
    expect(duplicate?.args[0]).toBe("--config");
    expect(duplicate?.args[1]).toContain("templates.duplicate_description=");
    expect(duplicate?.args.slice(2)).toEqual(["duplicate", "@"]);
    expect(execute.mock.calls.some(([input]) => input.args.includes("new"))).toBe(false);
    expect(readRevisionIdentity).toHaveBeenCalledWith(
      firstCwd,
      expect.stringContaining("description(substring:"),
    );
    const anchor = execute.mock.calls
      .map(([input]) => input)
      .find((input) => input.operation === "CheckpointStore.captureCheckpoint.jjAnchor");
    expect(anchor?.args.slice(0, -1)).toEqual([
      "--ignore-working-copy",
      "bookmark",
      "set",
      "--allow-backwards",
      "--revision",
      "checkpoint-commit",
    ]);
    expect(anchor?.args.at(-1)).toMatch(/^synara-snapshot\//);
    expect(physicalAnchor).toBeNull();
    expect(physicalRevisionPresent).toBe(false);
    expect(
      execute.mock.calls.filter(
        ([input]) => input.operation === "CheckpointStore.cleanupJjSnapshotBookmark",
      ),
    ).toHaveLength(2);
  });

  it("recovers a stale JJ working copy only when the caller marks it as managed", async () => {
    const checkpointRef = CheckpointRef.makeUnsafe(
      "refs/synara-checkpoints/thread/jj-managed-stale",
    );
    let stale = true;
    const execute = vi.fn<JjCoreShape["execute"]>((input) => {
      if (input.operation === "CheckpointStore.captureCheckpoint.jjSnapshot" && stale) {
        return Effect.fail(
          new JjCommandError({
            operation: input.operation,
            command: "jj status",
            cwd: input.cwd,
            detail: "The working copy is stale.",
          }),
        );
      }
      if (input.operation.endsWith(".updateStale")) {
        stale = false;
      }
      if (input.operation === "CheckpointStore.readJjTreeId") {
        return Effect.succeed({ code: 0, stdout: "managed-tree\n", stderr: "" });
      }
      return Effect.succeed({ code: 0, stdout: "", stderr: "" });
    });
    const jj = {
      execute,
      readRevisionIdentity: () =>
        Effect.succeed({
          changeId: "managed-change",
          commitId: "managed-commit",
          description: "managed snapshot",
        }),
      detectRepository: (cwd: string) =>
        Effect.succeed({
          workspaceRoot: cwd,
          repositoryStorePath: cwd,
          gitStorePath: null,
        }),
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
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const unmanaged = yield* store
          .captureCheckpoint({
            cwd: "/repo",
            backend: "jj",
            checkpointRef,
          })
          .pipe(
            Effect.as("captured" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
        yield* store.captureCheckpoint({
          cwd: "/repo",
          backend: "jj",
          checkpointRef,
          recoverStaleWorkingCopy: true,
        });
        return unmanaged;
      }),
    );

    expect(result).toBe("JjCommandError");
    expect(
      execute.mock.calls.filter(([input]) => input.operation.endsWith(".updateStale")),
    ).toHaveLength(1);
    expect(
      execute.mock.calls.filter(
        ([input]) => input.operation === "CheckpointStore.captureCheckpoint.jjSnapshot",
      ),
    ).toHaveLength(3);
  });

  it.skipIf(spawnSync("jj", ["--version"], { stdio: "ignore" }).status !== 0)(
    "round-trips catalog aliases and physical cleanup in a real JJ repository",
    async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-jj-checkpoint-store-"));
      tempDirs.push(cwd);
      execFileSync("jj", ["git", "init", cwd], { stdio: "pipe" });
      fs.writeFileSync(path.join(cwd, "state.txt"), "before\n", "utf8");

      const layer = CheckpointStoreLive.pipe(
        Layer.provide(
          Layer.succeed(GitCore, {
            execute: () => Effect.die("unexpected Git call"),
          } as unknown as GitCoreShape),
        ),
        Layer.provide(JjCoreLive),
        Layer.provide(NodeServices.layer),
        Layer.provide(SqlitePersistenceMemory),
      );
      runtime = ManagedRuntime.make(layer);

      const baselineRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/dGhyZWFk/turn/0");
      const baselineAlias = CheckpointRef.makeUnsafe(
        "refs/synara/checkpoints/dGhyZWFk/turn-start/dHVybg",
      );
      const endRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/dGhyZWFk/turn/1");
      const listInternalBookmarks = () =>
        execFileSync("jj", ["--ignore-working-copy", "bookmark", "list", "-T", 'name ++ "\\n"'], {
          cwd,
          encoding: "utf8",
        })
          .split("\n")
          .filter((name) => name.startsWith("synara-snapshot/"));

      const diff = await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          expect(yield* store.isRepository({ cwd, backend: "jj" })).toBe(true);
          yield* store.captureCheckpoint({
            cwd,
            backend: "jj",
            checkpointRef: baselineRef,
          });
          expect(
            yield* store.copyCheckpointRef({
              cwd,
              backend: "jj",
              fromCheckpointRef: baselineRef,
              toCheckpointRef: baselineAlias,
            }),
          ).toBe(true);
          fs.writeFileSync(path.join(cwd, "state.txt"), "after\n", "utf8");
          yield* store.captureCheckpoint({
            cwd,
            backend: "jj",
            checkpointRef: endRef,
          });
          return yield* store.diffCheckpoints({
            cwd,
            backend: "jj",
            fromCheckpointRef: baselineAlias,
            toCheckpointRef: endRef,
            ignoreWhitespace: false,
          });
        }),
      );

      expect(diff).toContain("-before");
      expect(diff).toContain("+after");
      expect(listInternalBookmarks()).toHaveLength(2);

      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* CheckpointStore;
          yield* store.deleteCheckpointRefs({
            cwd,
            backend: "jj",
            checkpointRefs: [baselineRef],
          });
          expect(listInternalBookmarks()).toHaveLength(2);
          yield* store.deleteCheckpointRefs({
            cwd,
            backend: "jj",
            checkpointRefs: [baselineAlias],
          });
          expect(listInternalBookmarks()).toHaveLength(1);
          yield* store.deleteCheckpointRefs({
            cwd,
            backend: "jj",
            checkpointRefs: [endRef],
          });
        }),
      );
      expect(listInternalBookmarks()).toHaveLength(0);
    },
  );

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
      detectRepository: (cwd: string) =>
        Effect.succeed({
          workspaceRoot: cwd,
          repositoryStorePath: cwd,
          gitStorePath: null,
        }),
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
      Layer.provide(SqlitePersistenceMemory),
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

  it("fails when a checkpoint ref cannot be deleted", async () => {
    const lockedRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/locked");
    const deletableRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/ok");
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `update-ref -d ${lockedRef}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "cannot lock ref\n" });
      }
      if (args === `update-ref -d ${deletableRef}`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({
            cwd: "/repo",
            backend: "git",
            checkpointRefs: [deletableRef, lockedRef],
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    // Every ref is still attempted; one loser must not abandon the batch.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result).not.toBe("success");
    expect(result).toContain(lockedRef);
    expect(result).toContain("cannot lock ref");
    expect(result).not.toContain(deletableRef);
  });

  it("tolerates deleting checkpoint refs that are already absent", async () => {
    // `git update-ref -d` exits 0 for a ref that does not exist, so the
    // exit-code check must not turn best-effort cleanup into a hard failure.
    const missingRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/thread/turn/gone");
    const execute = vi.fn<GitCoreShape["execute"]>(() =>
      Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    );
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(Layer.succeed(GitCore, { execute } as unknown as GitCoreShape)),
      Layer.provide(JjCoreLive),
      Layer.provide(NodeServices.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .deleteCheckpointRefs({
            cwd: "/repo",
            backend: "git",
            checkpointRefs: [missingRef],
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
      }),
    );

    expect(result).toBe("success");
  });
});
