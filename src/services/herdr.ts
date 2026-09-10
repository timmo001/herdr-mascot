import { HerdrSdk, herdrSdkLayerFromOptions } from "@herdr/sdk";
import { Duration, Effect, Layer, Option } from "effect";
import {
  Preferences,
  RuntimeConfig,
  mascotForDirectory,
  pluginId,
} from "../config";

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

export const currentTarget = Effect.gen(function* () {
  const herdr = yield* HerdrSdk;
  const preferences = yield* Preferences;
  const snapshot = yield* herdr.session.snapshot();
  const paneId = Option.getOrUndefined(snapshot.focusedPaneId);
  if (!paneId) return null;
  const layout = snapshot.layouts.find(
    (item) => item.tabId === Option.getOrUndefined(snapshot.focusedTabId),
  );
  const pane = layout?.panes.find((item) => item.paneId === paneId);
  if (!layout || !pane) return null;
  const graphics = yield* herdr.panes.graphics.info(paneId);
  if (
    !graphics.paneVisible ||
    graphics.cellWidthPx <= 0 ||
    graphics.cellHeightPx <= 0
  )
    return null;
  // Remove the two border cells and the right-hand scrollbar lane.
  const columns = Math.max(0, Math.floor(pane.rect.width) - 3);
  const rows = Math.max(0, Math.floor(pane.rect.height) - 2);
  if (columns < 1 || rows < 1) return null;
  const focusedPane = snapshot.panes.find((item) => item.id === paneId);
  const cwd = focusedPane
    ? (Option.getOrUndefined(focusedPane.foregroundCwd) ??
      Option.getOrUndefined(focusedPane.cwd))
    : undefined;
  return {
    paneId,
    mascotFile: mascotForDirectory(cwd, preferences),
    workspaceId: layout.workspaceId,
    tabId: layout.tabId,
    x: pane.rect.x * graphics.cellWidthPx,
    y: pane.rect.y * graphics.cellHeightPx,
    columns,
    rows,
    cellWidth: graphics.cellWidthPx,
    cellHeight: graphics.cellHeightPx,
  };
});

export type Target = NonNullable<Effect.Success<typeof currentTarget>>;
