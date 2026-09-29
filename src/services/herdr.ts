import { HerdrSdk, herdrSdkLayerFromOptions } from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option } from "effect";
import {
  Preferences,
  RuntimeConfig,
  mascotForDirectory,
  pluginId,
} from "../config";
import { Host } from "./host";

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
  const host = yield* Host;
  const preferences = yield* Preferences;
  const snapshot = yield* herdr.session.snapshot();
  const paneId = Option.getOrUndefined(snapshot.focusedPaneId);

  if (!paneId) return null;

  const layout = snapshot.layouts.find(
    (item) => item.tabId === Option.getOrUndefined(snapshot.focusedTabId),
  );

  const pane = layout?.panes.find((item) => item.paneId === paneId);

  if (!layout || !pane) return null;
  // Remove the two border cells and the right-hand scrollbar lane.
  const columns = Math.max(0, Math.floor(pane.rect.width) - 3);
  const rows = Math.max(0, Math.floor(pane.rect.height) - 2);

  if (columns < 1 || rows < 1) return null;
  const chrome = yield* host.chrome;

  // Herdr's sidebar sits left of the pane surface, and its tab bar or mobile header above or below it.
  const placements = (yield* host.clients).flatMap((client) => {
    const left = client.columns - layout.area.width;

    const top =
      chrome.tabBarBottom && client.columns > chrome.mobileWidthThreshold
        ? 0
        : client.rows - layout.area.height;

    return left < 0 || top < 0
      ? []
      : [
          {
            client,
            column: left + Math.floor(pane.rect.x) + 1,
            row: top + Math.floor(pane.rect.y) + 1,
          },
        ];
  });

  const [primary] = placements;

  if (!primary) return null;
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
    columns,
    rows,
    cellWidth: primary.client.cellWidth,
    cellHeight: primary.client.cellHeight,
    // Other clients scale the primary client's pixels to the same cells.
    placements: placements.map((item) => ({
      tty: item.client.tty,
      column: item.column,
      row: item.row,
    })),
  };
});

export type Target = NonNullable<Effect.Success<typeof currentTarget>>;
