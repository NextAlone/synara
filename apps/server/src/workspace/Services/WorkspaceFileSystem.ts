import { Effect, Schema, ServiceMap } from "effect";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@synara/contracts";
import { WorkspacePathOutsideRootError } from "./WorkspacePaths";

export class WorkspaceFileBinaryError extends Schema.TaggedErrorClass<WorkspaceFileBinaryError>()(
  "WorkspaceFileBinaryError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file is binary and cannot be previewed: ${this.relativePath}`;
  }
}

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `${this.operation} failed for ${this.cwd}: ${this.detail}`;
  }
}

export interface WorkspaceFileSystemShape {
  readonly readFile: (
    input: ProjectReadFileInput,
  ) => Effect.Effect<
    ProjectReadFileResult,
    WorkspaceFileBinaryError | WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
  readonly writeFile: (
    input: ProjectWriteFileInput,
  ) => Effect.Effect<
    ProjectWriteFileResult,
    WorkspaceFileSystemError | WorkspacePathOutsideRootError
  >;
}

export class WorkspaceFileSystem extends ServiceMap.Service<
  WorkspaceFileSystem,
  WorkspaceFileSystemShape
>()("synara/workspace/Services/WorkspaceFileSystem") {}
