import { Schema } from "effect";

/**
 * A typed boundary error for invoking JJ or decoding its machine output.
 */
export class JjCommandError extends Schema.TaggedErrorClass<JjCommandError>()("JjCommandError", {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    return `JJ command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}
