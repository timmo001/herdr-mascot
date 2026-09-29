import {
  HerdrSdk,
  PaneId,
  PluginId,
  herdrSdkLayerFromOptions,
} from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option } from "effect";
import {
  Preferences,
  RuntimeConfig,
  mascotForDirectory,
  pluginId,
} from "../config";

export const paneEntrypoint = "mascot";

const paneTitle = "Mascot";

export const herdrLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RuntimeConfig;

    return herdrSdkLayerFromOptions({
      socketPath: config.socket,
      requestTimeout: Duration.seconds(5),
    });
  }),
);

export const enabled = Effect.gen(function* () {
  const plugins = yield* (yield* HerdrSdk).plugins.list({ pluginId });

  return plugins.some((plugin) => plugin.id === pluginId && plugin.enabled);
});

// Opens the renderer's pane in a strip below the focused pane.
export const openPane = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;
  const config = yield* RuntimeConfig;
  const snapshot = yield* herdr.session.snapshot();

  if (Option.isNone(snapshot.focusedPaneId))
    return yield* Effect.logInfo("No focused pane to show the mascot beside");

  // A cold server restart brings the pane back as a plain shell.
  for (const pane of snapshot.panes)
    if (
      Option.getOrUndefined(pane.label) === paneTitle &&
      Option.getOrUndefined(pane.cwd) === config.root
    )
      yield* herdr.panes.close(pane.id);

  yield* herdr.plugins.panes.open(PluginId.make(pluginId), {
    entrypoint: paneEntrypoint,
    placement: "split",
    direction: "down",
    focus: false,
  });
});

// Shrinks the split holding the mascot's pane so it gets `rows` usable rows.
export const fitPane = Effect.fn("Herdr.fitPane")(function* (
  paneId: PaneId,
  currentRows: number,
  rows: number,
) {
  const herdr = yield* HerdrSdk;
  const layout = yield* herdr.panes.layout(paneId);
  const pane = layout.panes.find((item) => item.paneId === paneId);

  if (!pane || rows === currentRows) return;
  const bottom = pane.rect.y + pane.rect.height;

  const split = layout.splits
    .filter(
      (item) =>
        item.direction === "down" &&
        item.rect.y < pane.rect.y &&
        item.rect.y + item.rect.height === bottom &&
        item.rect.x <= pane.rect.x &&
        item.rect.x + item.rect.width >= pane.rect.x + pane.rect.width,
    )
    .toSorted((left, right) => left.rect.height - right.rect.height)[0];

  const path = split?.id.match(/^split_\d+_(root|[01]+)$/)?.[1];

  if (!split || path === undefined || split.rect.height <= 0) return;

  yield* herdr.layouts.setSplitRatio(
    { paneId },
    {
      path: path === "root" ? [] : path.split("").map((bit) => bit === "1"),
      ratio: Math.min(
        0.9,
        Math.max(0.1, split.ratio + (currentRows - rows) / split.rect.height),
      ),
    },
  );
});

export const currentFocus = Effect.fn("Herdr.currentFocus")(function* (
  ownPaneId: PaneId,
) {
  const herdr = yield* HerdrSdk;
  const preferences = yield* Preferences;
  const snapshot = yield* herdr.session.snapshot();
  const paneId = Option.getOrUndefined(snapshot.focusedPaneId);

  if (!paneId || paneId === ownPaneId) return null;
  const pane = snapshot.panes.find((item) => item.id === paneId);

  if (!pane) return null;

  const cwd =
    Option.getOrUndefined(pane.foregroundCwd) ??
    Option.getOrUndefined(pane.cwd);

  return {
    paneId,
    mascotFile: mascotForDirectory(cwd, preferences),
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
  };
});

export type Focus = NonNullable<
  Effect.Success<ReturnType<typeof currentFocus>>
>;
