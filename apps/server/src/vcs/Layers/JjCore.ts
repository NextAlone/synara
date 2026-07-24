import { Effect, Layer, Semaphore } from "effect";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

import { runProcess } from "../../processRunner.ts";
import { JjCommandError } from "../Errors.ts";
import {
  findJjWorkspaceRegistration,
  JJ_BOOKMARK_TEMPLATE,
  JJ_DIFF_ENTRY_TEMPLATE,
  JJ_REVISION_IDENTITY_TEMPLATE,
  JJ_WORKSPACE_TEMPLATE,
  parseJjBookmarks,
  parseJjFileChanges,
  parseJjRevisionIdentity,
  parseJjWorkspaces,
} from "../jjParsing.ts";
import {
  JjCore,
  type ExecuteJjInput,
  type ExecuteJjResult,
  type JjCoreShape,
  type JjDiffResult,
  type JjRepositoryInfo,
} from "../Services/JjCore.ts";

const JJ_MACHINE_ARGS = ["--no-pager", "--color", "never"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function commandLabel(args: ReadonlyArray<string>): string {
  return ["jj", ...JJ_MACHINE_ARGS, ...args].join(" ");
}

function commandError(
  input: Pick<ExecuteJjInput, "operation" | "cwd" | "args">,
  detail: string,
  cause?: unknown,
): JjCommandError {
  return new JjCommandError({
    operation: input.operation,
    command: commandLabel(input.args),
    cwd: input.cwd,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });
}

function parseOutput<A>(
  input: Pick<ExecuteJjInput, "operation" | "cwd" | "args">,
  parse: () => A,
): Effect.Effect<A, JjCommandError> {
  return Effect.try({
    try: parse,
    catch: (cause) => commandError(input, "JJ returned malformed machine output.", cause),
  });
}

async function resolveRepositoryStorePath(workspaceRoot: string): Promise<string> {
  const repoEntry = nodePath.join(workspaceRoot, ".jj", "repo");
  const stat = await nodeFs.lstat(repoEntry);
  if (stat.isDirectory()) {
    return nodeFs.realpath(repoEntry);
  }
  if (!stat.isFile()) {
    throw new Error(`${repoEntry} is neither a file nor a directory.`);
  }
  const target = (await nodeFs.readFile(repoEntry, "utf8")).trim();
  if (target.length === 0) {
    throw new Error(`${repoEntry} does not contain a repository target.`);
  }
  return nodeFs.realpath(nodePath.resolve(nodePath.dirname(repoEntry), target));
}

export const makeJjCore = (options?: { executeOverride?: JjCoreShape["execute"] }) =>
  Effect.gen(function* () {
    const execute: JjCoreShape["execute"] =
      options?.executeOverride ??
      ((input) =>
        Effect.tryPromise({
          try: () =>
            runProcess("jj", [...JJ_MACHINE_ARGS, ...input.args], {
              cwd: input.cwd,
              timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              maxBufferBytes: input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
              env: input.env ? { ...process.env, ...input.env } : process.env,
              allowNonZeroExit: true,
            }),
          catch: (cause) => commandError(input, "Failed to execute JJ.", cause),
        }).pipe(
          Effect.flatMap((result) => {
            const code = result.code ?? -1;
            if (!result.timedOut && (input.allowNonZeroExit || code === 0)) {
              return Effect.succeed({
                code,
                stdout: result.stdout,
                stderr: result.stderr,
              } satisfies ExecuteJjResult);
            }
            const stderr = result.stderr.trim();
            return Effect.fail(
              commandError(
                input,
                result.timedOut
                  ? "JJ timed out."
                  : stderr.length > 0
                    ? stderr
                    : `JJ exited with code ${code}.`,
              ),
            );
          }),
        ));

    const run = (
      operation: string,
      cwd: string,
      args: ReadonlyArray<string>,
      options?: Omit<ExecuteJjInput, "operation" | "cwd" | "args">,
    ) => execute({ operation, cwd, args, ...options });

    const detectRepository: JjCoreShape["detectRepository"] = (cwd) =>
      Effect.gen(function* () {
        const rootInput = {
          operation: "JjCore.detectRepository.root",
          cwd,
          args: ["--ignore-working-copy", "root"],
          allowNonZeroExit: true,
        } as const;
        const rootResult = yield* execute(rootInput);
        if (rootResult.code !== 0) {
          return null;
        }
        const root = rootResult.stdout.trim();
        if (root.length === 0) {
          return yield* commandError(rootInput, "JJ returned an empty workspace root.");
        }

        const workspaceRoot = yield* Effect.tryPromise({
          try: () => nodeFs.realpath(root),
          catch: (cause) => commandError(rootInput, "Failed to canonicalize the workspace root.", cause),
        });
        const repositoryStorePath = yield* Effect.tryPromise({
          try: () => resolveRepositoryStorePath(workspaceRoot),
          catch: (cause) =>
            commandError(rootInput, "Failed to resolve the shared JJ repository store.", cause),
        });

        const gitRootResult = yield* run(
          "JjCore.detectRepository.gitRoot",
          cwd,
          ["--ignore-working-copy", "git", "root"],
          { allowNonZeroExit: true },
        );
        const gitStorePath =
          gitRootResult.code === 0 && gitRootResult.stdout.trim().length > 0
            ? yield* Effect.tryPromise({
                try: () => nodeFs.realpath(gitRootResult.stdout.trim()),
                catch: (cause) =>
                  commandError(
                    {
                      operation: "JjCore.detectRepository.gitRoot",
                      cwd,
                      args: ["--ignore-working-copy", "git", "root"],
                    },
                    "Failed to canonicalize the JJ Git store.",
                    cause,
                  ),
              })
            : null;

        return {
          workspaceRoot,
          repositoryStorePath,
          gitStorePath,
        } satisfies JjRepositoryInfo;
      });

    const mutationLocks = new Map<
      string,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >();
    const withMutation: JjCoreShape["withMutation"] = (cwd, effect) =>
      Effect.gen(function* () {
        const repository = yield* detectRepository(cwd);
        const key = repository?.repositoryStorePath ?? nodePath.resolve(cwd);
        let entry = mutationLocks.get(key);
        if (!entry) {
          entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          mutationLocks.set(key, entry);
        }
        entry.users += 1;
        return yield* entry.semaphore.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry!.users -= 1;
              if (entry!.users === 0 && mutationLocks.get(key) === entry) {
                mutationLocks.delete(key);
              }
            }),
          ),
        );
      });

    const readRevisionIdentity: JjCoreShape["readRevisionIdentity"] = (cwd, revision = "@") => {
      const input = {
        operation: "JjCore.readRevisionIdentity",
        cwd,
        args: [
          "--ignore-working-copy",
          "log",
          "--no-graph",
          "-r",
          revision,
          "-n",
          "1",
          "-T",
          JJ_REVISION_IDENTITY_TEMPLATE,
        ],
      } as const;
      return execute(input).pipe(
        Effect.flatMap((result) =>
          parseOutput(input, () => parseJjRevisionIdentity(result.stdout)),
        ),
      );
    };

    const listBookmarksForChange = (cwd: string, currentChangeId: string) => {
      const input = {
        operation: "JjCore.listBookmarks",
        cwd,
        args: [
          "--ignore-working-copy",
          "bookmark",
          "list",
          "--all-remotes",
          "-T",
          JJ_BOOKMARK_TEMPLATE,
        ],
      } as const;
      return execute(input).pipe(
        Effect.flatMap((result) =>
          parseOutput(input, () => parseJjBookmarks(result.stdout, currentChangeId)),
        ),
      );
    };

    const listBookmarks: JjCoreShape["listBookmarks"] = (cwd) =>
      Effect.gen(function* () {
        const revision = yield* readRevisionIdentity(cwd);
        return yield* listBookmarksForChange(cwd, revision.changeId);
      });

    const readDiff = (
      operation: string,
      cwd: string,
      revisionArgs: ReadonlyArray<string>,
      ignoreWorkingCopy: boolean,
    ): Effect.Effect<JjDiffResult, JjCommandError> => {
      const fileInput = {
        operation: `${operation}.files`,
        cwd,
        args: [
          ...(ignoreWorkingCopy ? ["--ignore-working-copy"] : []),
          "diff",
          ...revisionArgs,
          "-T",
          JJ_DIFF_ENTRY_TEMPLATE,
        ],
      };
      const patchInput = {
        operation: `${operation}.patch`,
        cwd,
        args: [
          "--ignore-working-copy",
          "diff",
          ...revisionArgs,
          "--git",
        ],
        maxOutputBytes: 16 * 1024 * 1024,
      };
      return Effect.gen(function* () {
        // The first command deliberately snapshots once. Every dependent read
        // then observes that exact working-copy operation without resnapshotting.
        const fileResult = yield* execute(fileInput);
        const files = yield* parseOutput(fileInput, () => parseJjFileChanges(fileResult.stdout));
        const patchResult = yield* execute(patchInput);
        return { patch: patchResult.stdout, files };
      });
    };

    const status: JjCoreShape["status"] = (cwd) =>
      Effect.gen(function* () {
        const fileInput = {
          operation: "JjCore.status.files",
          cwd,
          args: ["diff", "-r", "@", "-T", JJ_DIFF_ENTRY_TEMPLATE],
        } as const;
        const fileResult = yield* execute(fileInput);
        const files = yield* parseOutput(fileInput, () => parseJjFileChanges(fileResult.stdout));
        const revision = yield* readRevisionIdentity(cwd);
        const [repository, bookmarks] = yield* Effect.all(
          [detectRepository(cwd), listBookmarksForChange(cwd, revision.changeId)],
          { concurrency: 2 },
        );
        if (!repository) {
          return yield* commandError(fileInput, "JJ repository disappeared after status refresh.");
        }
        return {
          repository,
          revision,
          bookmarks,
          files,
          hasChanges: files.length > 0,
          hasConflicts: files.some((file) => file.conflicted),
        };
      });

    const readRevisionDiff: JjCoreShape["readRevisionDiff"] = (cwd, revision = "@") =>
      readDiff("JjCore.readRevisionDiff", cwd, ["-r", revision], false);

    const readRangeDiff: JjCoreShape["readRangeDiff"] = (cwd, fromRevision, toRevision) =>
      readDiff(
        "JjCore.readRangeDiff",
        cwd,
        ["--from", fromRevision, "--to", toRevision],
        false,
      );

    const listWorkspaces: JjCoreShape["listWorkspaces"] = (repositoryPath) => {
      const input = {
        operation: "JjCore.listWorkspaces",
        cwd: repositoryPath,
        args: [
          "--repository",
          repositoryPath,
          "--ignore-working-copy",
          "workspace",
          "list",
          "-T",
          JJ_WORKSPACE_TEMPLATE,
        ],
      } as const;
      return execute(input).pipe(
        Effect.flatMap((result) => parseOutput(input, () => parseJjWorkspaces(result.stdout))),
      );
    };

    const getWorkspaceRegistration: JjCoreShape["getWorkspaceRegistration"] = (
      repositoryPath,
      workspaceName,
    ) =>
      listWorkspaces(repositoryPath).pipe(
        Effect.map((workspaces) => findJjWorkspaceRegistration(workspaces, workspaceName)),
      );

    const createWorkspace: JjCoreShape["createWorkspace"] = (input) =>
      withMutation(
        input.repositoryPath,
        Effect.gen(function* () {
          const before = yield* getWorkspaceRegistration(input.repositoryPath, input.workspaceName);
          if (before.kind !== "absent") {
            return yield* commandError(
              {
                operation: "JjCore.createWorkspace",
                cwd: input.repositoryPath,
                args: ["workspace", "add", input.workspacePath],
              },
              `Workspace '${input.workspaceName}' is already ${before.kind}.`,
            );
          }
          yield* run("JjCore.createWorkspace", input.repositoryPath, [
            "--repository",
            input.repositoryPath,
            "workspace",
            "add",
            "--name",
            input.workspaceName,
            "--revision",
            input.revision,
            "--message",
            input.message,
            input.workspacePath,
          ]);
          const registration = yield* getWorkspaceRegistration(
            input.repositoryPath,
            input.workspaceName,
          );
          if (registration.kind !== "present") {
            return yield* commandError(
              {
                operation: "JjCore.createWorkspace.verify",
                cwd: input.repositoryPath,
                args: ["workspace", "list"],
              },
              `Workspace '${input.workspaceName}' was not registered after creation.`,
            );
          }
          const [actualPath, expectedPath] = yield* Effect.all([
            Effect.tryPromise({
              try: () => nodeFs.realpath(registration.root),
              catch: (cause) =>
                commandError(
                  {
                    operation: "JjCore.createWorkspace.verify",
                    cwd: input.repositoryPath,
                    args: ["workspace", "list"],
                  },
                  "Failed to canonicalize the registered workspace path.",
                  cause,
                ),
            }),
            Effect.tryPromise({
              try: () => nodeFs.realpath(input.workspacePath),
              catch: (cause) =>
                commandError(
                  {
                    operation: "JjCore.createWorkspace.verify",
                    cwd: input.repositoryPath,
                    args: ["workspace", "list"],
                  },
                  "Failed to canonicalize the requested workspace path.",
                  cause,
                ),
            }),
          ]);
          if (actualPath !== expectedPath) {
            return yield* commandError(
              {
                operation: "JjCore.createWorkspace.verify",
                cwd: input.repositoryPath,
                args: ["workspace", "list"],
              },
              `Workspace '${input.workspaceName}' was registered at '${actualPath}', expected '${expectedPath}'.`,
            );
          }
          yield* run("JjCore.createWorkspace.status", actualPath, ["status"]);
          const revision = yield* readRevisionIdentity(actualPath);
          return { name: input.workspaceName, path: actualPath, revision };
        }),
      );

    const forgetWorkspace: JjCoreShape["forgetWorkspace"] = (repositoryPath, workspaceName) =>
      withMutation(
        repositoryPath,
        Effect.gen(function* () {
          yield* run("JjCore.forgetWorkspace", repositoryPath, [
            "--repository",
            repositoryPath,
            "--ignore-working-copy",
            "workspace",
            "forget",
            workspaceName,
          ]);
          const registration = yield* getWorkspaceRegistration(repositoryPath, workspaceName);
          if (registration.kind !== "absent") {
            return yield* commandError(
              {
                operation: "JjCore.forgetWorkspace.verify",
                cwd: repositoryPath,
                args: ["workspace", "list"],
              },
              `Workspace '${workspaceName}' remains ${registration.kind} after forget.`,
            );
          }
        }),
      );

    const createBookmark: JjCoreShape["createBookmark"] = (cwd, name, revision) =>
      withMutation(
        cwd,
        run("JjCore.createBookmark", cwd, [
          "bookmark",
          "create",
          "--revision",
          revision,
          name,
        ]).pipe(Effect.asVoid),
      );

    const describeRevision: JjCoreShape["describeRevision"] = (cwd, revision, message) =>
      withMutation(
        cwd,
        run("JjCore.describeRevision", cwd, ["describe", "--message", message, revision]).pipe(
          Effect.asVoid,
        ),
      );

    const commitWorkingCopy: JjCoreShape["commitWorkingCopy"] = (cwd, message) =>
      withMutation(
        cwd,
        Effect.gen(function* () {
          yield* run("JjCore.commitWorkingCopy", cwd, ["commit", "--message", message]);
          return yield* readRevisionIdentity(cwd, "@-");
        }),
      );

    return {
      execute,
      withMutation,
      detectRepository,
      readRevisionIdentity,
      listBookmarks,
      status,
      readRevisionDiff,
      readRangeDiff,
      listWorkspaces,
      getWorkspaceRegistration,
      createWorkspace,
      forgetWorkspace,
      createBookmark,
      describeRevision,
      commitWorkingCopy,
    } satisfies JjCoreShape;
  });

export const JjCoreLive = Layer.effect(JjCore, makeJjCore());
