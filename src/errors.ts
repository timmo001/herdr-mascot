import { Cause, Effect } from "effect";

export const reportError = Effect.fn("Errors.reportError")(function* (
  cause: Cause.Cause<unknown>,
  title = "Herdr Mascot failed",
) {
  if (!Cause.hasInterruptsOnly(cause)) yield* Effect.logError(title, cause);
});
