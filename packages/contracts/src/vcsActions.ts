import { Option, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";
import { DEFAULT_GIT_TEXT_GENERATION_MODEL } from "./model";
import { ModelSelection, ProviderStartOptions } from "./orchestration";
import { VcsProjectTarget } from "./vcs";

export const VcsStackedAction = Schema.Literals([
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
]);
export type VcsStackedAction = typeof VcsStackedAction.Type;

export const VcsStackedActionFields = {
  actionId: TrimmedNonEmptyString,
  action: VcsStackedAction,
  commitMessage: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(10_000)),
  ),
  featureBranch: Schema.optional(Schema.Boolean),
  filePaths: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  ),
  codexHomePath: Schema.optional(TrimmedNonEmptyString),
  providerOptions: Schema.optional(ProviderStartOptions),
  textGenerationModel: Schema.optional(TrimmedNonEmptyString).pipe(
    Schema.withConstructorDefault(() =>
      Option.some(DEFAULT_GIT_TEXT_GENERATION_MODEL),
    ),
  ),
  textGenerationModelSelection: Schema.optional(ModelSelection),
} as const;

/**
 * Backend-neutral commit/push/PR workflow. The action vocabulary and result
 * shape intentionally stay aligned with the existing Git UI contract; JJ maps
 * "branch" to bookmark and "commitSha" to the committed JJ commit ID.
 */
export const VcsRunStackedActionInput = Schema.Struct({
  ...VcsProjectTarget.fields,
  ...VcsStackedActionFields,
});
export type VcsRunStackedActionInput =
  typeof VcsRunStackedActionInput.Type;
