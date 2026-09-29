import { Context, Effect, Layer, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
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

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      // The detached renderer owns its lease and graphics scopes.
      const detach = Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "sh",
            [
              "-c",
              'umask 077; log=$1; shift; exec "$@" >>"$log" 2>&1',
              "sh",
              path.join(config.state, "watch.log"),
              process.execPath,
              path.join(config.root, "dist/index.js"),
              "watch",
            ],
            {
              cwd: config.root,
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            },
          ),
        );

        yield* Effect.asVoid(child.unref);
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
