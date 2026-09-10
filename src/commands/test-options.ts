import { Effect, FileSystem, Path } from "effect";
import { check, lock } from "proper-lockfile";
import { start, stop } from "./watch";
import {
  ConfigError,
  RuntimeConfig,
  loadSettings,
  type Position,
} from "../config";
import { currentTarget, enabled } from "../services/herdr";

const positions = [
  "bottom-left",
  "center-bottom",
  "bottom-right",
  "top-right",
  "center-top",
  "top-left",
] satisfies readonly Position[];

export const testOptions = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* enabled) || !(yield* currentTarget))
    return yield* new ConfigError({
      message:
        "Enable the mascot and focus a pane with graphics support first.",
    });

  yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(path.join(config.configDir, "test-options"), { realpath: false }),
    ),
    (release) => Effect.tryPromise(() => release()).pipe(Effect.orDie),
  );
  const { settings } = yield* loadSettings(config.settingsFile);
  const running = Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );
  yield* Effect.acquireRelease(
    Effect.gen(function* () {
      const contents = (yield* fs.exists(config.settingsFile))
        ? yield* fs.readFile(config.settingsFile)
        : undefined;
      return { contents, wasRunning: yield* running };
    }),
    ({ contents, wasRunning }) =>
      stop.pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (contents === undefined)
              yield* fs.remove(config.settingsFile, { force: true });
            else yield* fs.writeFile(config.settingsFile, contents);
            if (wasRunning) yield* start;
            yield* Effect.logInfo(
              "Restored mascot configuration and visibility",
            );
          }).pipe(Effect.orDie),
        ),
        Effect.orDie,
      ),
  );

  yield* stop;
  for (const position of positions) {
    yield* Effect.logInfo(`Testing ${position}`);
    yield* fs.writeFileString(
      config.settingsFile,
      JSON.stringify({ ...settings, position, animationDelayMs: 0 }, null, 2),
      { mode: 0o600 },
    );
    yield* start;
    yield* Effect.gen(function* () {
      while (!(yield* running)) yield* Effect.sleep(50);
    }).pipe(Effect.timeout(5_000));
    yield* Effect.sleep(3_000);
    yield* stop;
    yield* Effect.sleep(500);
  }
}).pipe(Effect.scoped);
