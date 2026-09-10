import { HerdrSdk } from "@herdr/sdk";
import {
  Clock,
  Deferred,
  Effect,
  FileSystem,
  Path,
  Queue,
  Random,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { check, lock } from "proper-lockfile";
import {
  exitPosition,
  frameAt,
  graphicsFrame,
  jumpPosition,
  restingPosition,
  sameTarget,
} from "../animation";
import { Preferences, RuntimeConfig, layerId } from "../config";
import { currentTarget, enabled, type Target } from "../services/herdr";
import { Mascot, type Frame } from "../services/mascot";
import { Process, ProcessError } from "../services/process";
import { waitForUpdate } from "../services/reload";

export const start = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* enabled)) return;
  yield* fs.remove(path.join(config.state, "stopped"), { force: true });
  const held = yield* Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );
  if (!held) yield* (yield* Process).detach;
});

export const stop = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path.join(config.state, "stopped"), "", {
    mode: 0o600,
  });
  yield* Effect.gen(function* () {
    while (
      yield* Effect.tryPromise(() =>
        check(path.join(config.state, "watcher"), {
          realpath: false,
          stale: 15_000,
        }),
      )
    )
      yield* Effect.sleep(50);
  }).pipe(Effect.timeout(20_000));
});

export const toggle = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const held = yield* Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );
  yield* held ? stop : start;
});

const waitUntilStopped = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.gen(function* () {
    while (
      !(yield* fs.exists(path.join(config.state, "stopped"))) &&
      (yield* enabled)
    )
      yield* Effect.sleep(500);
  }).pipe(
    Effect.raceFirst(
      fs.watch(config.state).pipe(
        Stream.mapEffect(() => fs.exists(path.join(config.state, "stopped"))),
        Stream.filter((stopped) => stopped),
        Stream.runHead,
      ),
    ),
  );
});

const render = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;
  const config = yield* Preferences;
  const mascot = yield* Mascot;
  const target = yield* Ref.make<Target | null>(yield* currentTarget);
  const stopping = yield* Ref.make(false);
  const changed = yield* Queue.sliding<void>(1);
  const jumpDuration = mascot.jump.reduce(
    (total, frame) => total + frame.durationMs,
    0,
  );
  const track = Stream.merge(
    herdr.events
      .subscribe([
        { type: "pane.focused" },
        { type: "workspace.focused" },
        { type: "tab.focused" },
        { type: "layout.updated" },
        { type: "pane.closed" },
      ])
      .pipe(Stream.map(() => undefined)),
    Stream.tick(1_000),
  ).pipe(
    Stream.runForEach(
      Effect.fn("Mascot.trackTarget")(function* () {
        const value = yield* currentTarget;
        if (sameTarget(value, yield* Ref.get(target))) return;
        yield* Ref.set(target, value);
        yield* Queue.offer(changed, undefined);
      }),
    ),
  );

  const draw = Effect.gen(function* () {
    let previous: Target | null = null;
    while (!(yield* Ref.get(stopping))) {
      const selected = yield* Ref.get(target);
      if (!selected) {
        previous = null;
        yield* Queue.take(changed);
        continue;
      }
      const destination = restingPosition(
        selected,
        mascot.size,
        config.position,
      );
      const shouldJump =
        previous?.paneId !== selected.paneId ||
        previous.tabId !== selected.tabId;
      const entryDuration: number = shouldJump ? jumpDuration : 0;
      if (shouldJump && config.animationDelayMs > 0) {
        yield* Effect.sleep(config.animationDelayMs);
        if (
          (yield* Ref.get(stopping)) ||
          !sameTarget(selected, yield* Ref.get(target))
        )
          continue;
      }
      const exited = yield* herdr.panes.graphics.withLayerStream(
        selected.paneId,
        { layerId, zIndex: 100 },
        (writer) =>
          Effect.gen(function* () {
            const started = yield* Clock.currentTimeMillis;
            let lastFrame: Frame | undefined;
            let lastX = Number.NaN;
            let lastY = Number.NaN;
            while (
              !(yield* Ref.get(stopping)) &&
              sameTarget(selected, yield* Ref.get(target))
            ) {
              const elapsed = (yield* Clock.currentTimeMillis) - started;
              const jumping = elapsed < entryDuration;
              const point = jumping
                ? jumpPosition(selected, destination, elapsed / entryDuration)
                : destination;
              const frame = frameAt(
                jumping ? mascot.jump : mascot.idle,
                jumping ? elapsed : elapsed - entryDuration,
              );
              const x = Math.round(point.x);
              const y = Math.round(point.y);
              if (frame !== lastFrame || x !== lastX || y !== lastY) {
                yield* writer.write(
                  graphicsFrame(frame, selected, x, y, destination.size),
                );
                lastFrame = frame;
                lastX = x;
                lastY = y;
              }
              yield* Queue.take(changed).pipe(
                Effect.timeoutOrElse({
                  duration: jumping ? 33 : 50,
                  orElse: () => Effect.void,
                }),
              );
            }
            const next = yield* Ref.get(target);
            if (
              !lastFrame ||
              (!(yield* Ref.get(stopping)) && next?.paneId === selected.paneId)
            )
              return false;
            if (config.animationDelayMs > 0) {
              yield* Effect.sleep(config.animationDelayMs);
              if (
                !(yield* Ref.get(stopping)) &&
                sameTarget(selected, yield* Ref.get(target))
              )
                return false;
            }
            const graphics = yield* herdr.panes.graphics.info(selected.paneId);
            if (!graphics.paneVisible) return true;
            const origin = { x: lastX, y: lastY, size: destination.size };
            const direction = (yield* Random.nextBoolean) ? "right" : "down";
            const exitStarted = yield* Clock.currentTimeMillis;
            while (true) {
              const elapsed = (yield* Clock.currentTimeMillis) - exitStarted;
              const latest = yield* Ref.get(target);
              if (
                elapsed >= 250 ||
                (latest &&
                  (latest.tabId !== selected.tabId ||
                    latest.workspaceId !== selected.workspaceId))
              )
                break;
              const point = exitPosition(
                selected,
                origin,
                elapsed / 250,
                direction,
              );
              yield* writer.write(
                graphicsFrame(
                  frameAt(mascot.jump, (elapsed / 250) * jumpDuration),
                  selected,
                  point.x,
                  point.y,
                  destination.size,
                ),
              );
              yield* Effect.sleep(33);
            }
            return true;
          }),
      );
      previous = exited ? null : selected;
    }
  });
  yield* draw.pipe(
    Effect.raceFirst(track),
    Effect.raceFirst(
      waitUntilStopped.pipe(
        Effect.andThen(Ref.set(stopping, true)),
        Effect.andThen(Queue.offer(changed, undefined)),
        Effect.andThen(Effect.never),
      ),
    ),
  );
});

const runWatcher = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const compromised = yield* Deferred.make<never, ProcessError>();
  const lease = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      lock(path.join(config.state, "watcher"), {
        realpath: false,
        stale: 15_000,
        update: 5_000,
        onCompromised: (cause) =>
          Deferred.doneUnsafe(
            compromised,
            Effect.fail(
              new ProcessError({ command: "watch", message: String(cause) }),
            ),
          ),
      }),
    ).pipe(
      Effect.catch((error) =>
        Schema.is(Schema.Struct({ code: Schema.Literal("ELOCKED") }))(
          error.cause,
        )
          ? Effect.succeed(null)
          : Effect.fail(
              new ProcessError({ command: "watch", message: String(error) }),
            ),
      ),
    ),
    (release) =>
      release
        ? Effect.tryPromise(() => release()).pipe(
            Effect.catch((cause) =>
              Effect.logError("Could not release mascot lease", cause),
            ),
          )
        : Effect.void,
  );
  if (!lease) return false;
  yield* Effect.logInfo("Herdr Mascot started");
  return yield* render.pipe(
    Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
    Effect.as(false),
    Effect.raceFirst(waitForUpdate.pipe(Effect.as(true))),
    Effect.raceFirst(Deferred.await(compromised)),
  );
}).pipe(Effect.scoped);

export const watch = Effect.gen(function* () {
  const restart = yield* runWatcher;
  if (restart && (yield* enabled)) {
    yield* Effect.logInfo("Herdr Mascot changed; starting a new renderer");
    yield* (yield* Process).detach;
  }
});
