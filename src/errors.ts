import { Cause, Effect, Schema } from "effect";

export class ProcessError extends Schema.TaggedError<ProcessError>()(
  "ProcessError",
  { command: Schema.String, message: Schema.String },
) {}

export const reportError = Effect.fn("Errors.reportError")(function* (
  cause: Cause.Cause<unknown>,
  title = "Herdr Mascot failed",
) {
  if (!Cause.hasInterruptsOnly(cause)) yield* Effect.logError(title, cause);
});
