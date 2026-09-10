import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { Context, Effect, Layer, Path, Schema } from "effect";
import { RuntimeConfig } from "../config";

export class ProcessError extends Schema.TaggedError<ProcessError>()(
  "ProcessError",
  { command: Schema.String, message: Schema.String },
) {}

export class Process extends Context.Service<
  Process,
  { readonly detach: Effect.Effect<void, ProcessError> }
>()("herdr-mascot/Process") {
  static readonly layer = Layer.effect(
    Process,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const path = yield* Path.Path;
      // The detached renderer owns its lease and graphics scopes.
      const detach = Effect.gen(function* () {
        const fd = yield* Effect.acquireRelease(
          Effect.try(() =>
            openSync(path.join(config.state, "watch.log"), "a", 0o600),
          ),
          (file) => Effect.sync(() => closeSync(file)),
        );
        yield* Effect.callback<void, ProcessError>((resume) => {
          const child = spawn(
            process.execPath,
            [path.join(config.root, "dist/index.js"), "watch"],
            { cwd: config.root, detached: true, stdio: ["ignore", fd, fd] },
          );
          child.once("error", (cause) =>
            resume(
              Effect.fail(
                new ProcessError({ command: "watch", message: String(cause) }),
              ),
            ),
          );
          child.once("spawn", () => {
            child.unref();
            resume(Effect.void);
          });
        });
      }).pipe(
        Effect.scoped,
        Effect.mapError(
          (cause) =>
            new ProcessError({ command: "watch", message: String(cause) }),
        ),
      );
      return Process.of({ detach });
    }),
  );
}
