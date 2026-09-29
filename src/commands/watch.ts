import { HerdrSdk, PaneId } from "@timmo001/effect-herdr";
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
  frameImage,
  jumpPosition,
  restingPosition,
  sameTarget,
  type Target,
} from "../animation";
import {
  Preferences,
  RuntimeConfig,
  bottomCorners,
  bottomPositions,
  corners,
  positions,
  topCorners,
  topPositions,
  type Position,
} from "../config";
import { ProcessError } from "../errors";
import {
  currentFocus,
  enabled,
  fitPane,
  openPane,
  type Focus,
} from "../services/herdr";
import { Mascot, type Frame } from "../services/mascot";
import { waitForUpdate } from "../services/reload";
import { Terminal } from "../services/terminal";

const running = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;

  return yield* Effect.tryPromise(() =>
    check(path.join(config.state, "watcher"), {
      realpath: false,
      stale: 15_000,
    }),
  );
});

export const start = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;

  if (!(yield* enabled)) return;
  yield* fs.remove(path.join(config.state, "stopped"), { force: true });

  if (!(yield* running)) yield* openPane;
});

export const stop = Effect.gen(function* () {
  const config = yield* RuntimeConfig;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path.join(config.state, "stopped"), "", {
    mode: 0o600,
  });
  yield* Effect.gen(function* () {
    while (yield* running) yield* Effect.sleep(50);
  }).pipe(Effect.timeout(20_000));
});

export const toggle = Effect.gen(function* () {
  yield* (yield* running) ? stop : start;
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

const render = Effect.fn("Mascot.render")(function* (ownPaneId: PaneId) {
  const herdr = yield* HerdrSdk;
  const config = yield* Preferences;
  const mascots = yield* Mascot;
  const terminal = yield* Terminal;
  const focus = yield* Ref.make<Focus | null>(null);
  const target = yield* Ref.make<Target | null>(null);
  const stopping = yield* Ref.make(false);
  const changed = yield* Queue.sliding<void>(1);

  // Focusing the mascot's own pane keeps the previous pane's mascot.
  const refresh = Effect.gen(function* () {
    const next = yield* currentFocus(ownPaneId);

    if (next) yield* Ref.set(focus, next);
    const selected = yield* Ref.get(focus);
    const geometry = yield* terminal.geometry;
    const value = selected && geometry ? { ...selected, ...geometry } : null;

    if (sameTarget(value, yield* Ref.get(target))) return;
    yield* Ref.set(target, value);
    yield* Queue.offer(changed, undefined);
  });

  yield* refresh;

  const track = Stream.mergeAll(
    [
      herdr.events
        .subscribe([
          { type: "pane.focused" },
          { type: "workspace.focused" },
          { type: "tab.focused" },
          { type: "layout.updated" },
          { type: "pane.closed" },
        ])
        .pipe(Stream.map(() => undefined)),
      terminal.resized,
      Stream.tick(1_000),
    ],
    { concurrency: "unbounded" },
  ).pipe(Stream.runForEach(() => refresh));

  // Shrink the new pane to the mascot's height once Herdr has sized it.
  const fit = Effect.gen(function* () {
    while (!(yield* terminal.geometry)) yield* Effect.sleep(50);
    yield* Effect.sleep(250);
    const geometry = yield* terminal.geometry;

    if (!geometry) return;
    yield* fitPane(
      ownPaneId,
      geometry.rows,
      Math.ceil(config.sizePixels / geometry.cellHeight) + 1,
    );
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Could not resize the mascot pane", cause),
    ),
  );

  const draw = Effect.gen(function* () {
    let previous: Target | null = null;
    let position: Position = "bottom-right";

    while (!(yield* Ref.get(stopping))) {
      const selected = yield* Ref.get(target);

      if (!selected) {
        previous = null;
        yield* Queue.take(changed);
        continue;
      }

      const shouldJump =
        previous?.paneId !== selected.paneId ||
        previous.mascotFile !== selected.mascotFile ||
        previous.tabId !== selected.tabId ||
        previous.workspaceId !== selected.workspaceId;

      const mascot = yield* mascots.get(selected.mascotFile);

      const jumpDuration = mascot.jump.reduce(
        (total, frame) => total + frame.durationMs,
        0,
      );

      if (shouldJump) {
        switch (config.position) {
          case "random":
            position = yield* Random.choice(positions);
            break;
          case "bottom-random":
            position = yield* Random.choice(bottomPositions);
            break;
          case "top-random":
            position = yield* Random.choice(topPositions);
            break;
          case "random-corners":
            position = yield* Random.choice(corners);
            break;
          case "bottom-random-corners":
            position = yield* Random.choice(bottomCorners);
            break;
          case "top-random-corners":
            position = yield* Random.choice(topCorners);
            break;
          default:
            position = config.position;
        }
      }

      const destination = restingPosition(selected, mascot.size, position);
      const flipHorizontal = mascot.flipOnLeft && position.endsWith("left");

      const entryDuration: number = shouldJump
        ? jumpDuration * (yield* Random.nextBetween(0.8, 1.2))
        : 0;

      const entryLift = yield* Random.nextBetween(0.35, 0.75);

      const entryDirection =
        !position.startsWith("center-") && (yield* Random.nextBoolean)
          ? "horizontal"
          : "vertical";

      if (shouldJump && config.animationDelayMs > 0) {
        yield* Effect.sleep(config.animationDelayMs);

        if (
          (yield* Ref.get(stopping)) ||
          !sameTarget(selected, yield* Ref.get(target))
        )
          continue;
      }

      const exited = yield* Effect.gen(function* () {
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
            ? jumpPosition(
                selected,
                destination,
                elapsed / entryDuration,
                position,
                entryDirection,
                entryLift,
              )
            : destination;

          const frame = frameAt(
            jumping ? mascot.jump : mascot.idle,
            jumping
              ? (elapsed / entryDuration) * jumpDuration
              : elapsed - entryDuration,
          );

          const x = Math.round(point.x);
          const y = Math.round(point.y);

          if (frame !== lastFrame || x !== lastX || y !== lastY) {
            yield* terminal.draw(
              frameImage(
                frame,
                selected,
                x,
                y,
                destination.size,
                flipHorizontal,
              ),
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
          (!(yield* Ref.get(stopping)) &&
            next?.paneId === selected.paneId &&
            next.mascotFile === selected.mascotFile)
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

        const origin = { x: lastX, y: lastY, size: destination.size };

        const direction =
          !position.startsWith("center-") && (yield* Random.nextBoolean)
            ? "horizontal"
            : "vertical";

        const exitDuration = yield* Random.nextBetween(200, 300);
        const exitLift = yield* Random.nextBetween(0.35, 0.75);
        const exitStarted = yield* Clock.currentTimeMillis;

        while (true) {
          const elapsed = (yield* Clock.currentTimeMillis) - exitStarted;

          if (elapsed >= exitDuration) break;

          const point = exitPosition(
            selected,
            origin,
            elapsed / exitDuration,
            position,
            direction,
            exitLift,
          );

          yield* terminal.draw(
            frameImage(
              frameAt(mascot.jump, (elapsed / exitDuration) * jumpDuration),
              selected,
              point.x,
              point.y,
              destination.size,
              flipHorizontal,
            ),
          );
          yield* Effect.sleep(33);
        }

        yield* terminal.clear;

        return true;
      });

      previous = exited ? null : selected;
    }
  });

  yield* draw.pipe(
    Effect.raceFirst(track),
    Effect.raceFirst(fit.pipe(Effect.andThen(Effect.never))),
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

  const paneId = yield* Schema.decodeUnknownEffect(PaneId)(
    process.env.HERDR_PANE_ID,
  ).pipe(
    Effect.mapError(
      () =>
        new ProcessError({
          command: "watch",
          message: "The mascot renderer must run inside its Herdr pane.",
        }),
    ),
  );

  yield* Effect.logInfo("Herdr Mascot started");

  return yield* render(paneId).pipe(
    Effect.retry({ times: 5, schedule: Schedule.spaced(1_000) }),
    Effect.as(false),
    Effect.raceFirst(waitForUpdate.pipe(Effect.as(true))),
    Effect.raceFirst(Deferred.await(compromised)),
    Effect.provide(Terminal.layer),
  );
}).pipe(Effect.scoped);

export const watch = Effect.gen(function* () {
  const restart = yield* runWatcher;

  // Replace this process so the pane keeps its place in the layout.
  if (restart && (yield* enabled))
    yield* Effect.sync(() =>
      process.execve?.(process.execPath, process.argv, process.env),
    );
});
