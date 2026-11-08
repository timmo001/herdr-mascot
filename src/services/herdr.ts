import { HerdrSdk, herdrSdkLayerFromOptions } from "@timmo001/effect-herdr";
import { Duration, Effect, Layer, Option } from "effect";
import {
  Preferences,
  RuntimeConfig,
  mascotForDirectory,
  pluginId,
} from "../config";
import { Host, type Chrome } from "./host";

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

type Rect = { x: number; y: number; width: number; height: number };

type Layout = {
  readonly zoomed: boolean;
  readonly area: Rect;
  readonly panes: ReadonlyArray<{
    readonly paneId: string;
    readonly rect: Rect;
  }>;
};

const overlaps = (
  start: number,
  length: number,
  otherStart: number,
  otherLength: number,
) => start < otherStart + otherLength && otherStart < start + length;

// The cells of a pane its terminal draws in, after Herdr's borders and scrollbar lane.
const paneSurface = (layout: Layout, paneId: string, chrome: Chrome) => {
  const pane = layout.panes.find((item) => item.paneId === paneId);

  if (!pane) return null;
  const multiPane = layout.panes.length > 1;

  const bordered =
    chrome.paneBorders !== "off" &&
    (multiPane || chrome.paneBorders === "always");

  // A zoomed pane covers the whole tab, framed only while outer borders are on.
  const rect = layout.zoomed ? layout.area : pane.rect;
  const framed = layout.zoomed ? bordered && chrome.paneOuterBorders : bordered;
  const rects = layout.zoomed ? [rect] : layout.panes.map((item) => item.rect);
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  // Without gaps, a pane shares the divider of its right and lower neighbours.
  const sharesRight =
    !chrome.paneGaps &&
    rects.some(
      (item) =>
        item.x === right && overlaps(rect.y, rect.height, item.y, item.height),
    );

  const sharesBottom =
    !chrome.paneGaps &&
    rects.some(
      (item) =>
        item.y === bottom && overlaps(rect.x, rect.width, item.x, item.width),
    );

  // Without outer borders, edges along the outside of the pane area go.
  const outer = (edge: boolean) => !chrome.paneOuterBorders && edge;

  const borders = {
    left: framed && !outer(rect.x === Math.min(...rects.map((item) => item.x))),
    top: framed && !outer(rect.y === Math.min(...rects.map((item) => item.y))),
    right:
      framed &&
      !sharesRight &&
      !outer(right === Math.max(...rects.map((item) => item.x + item.width))),
    bottom:
      framed &&
      !sharesBottom &&
      !outer(bottom === Math.max(...rects.map((item) => item.y + item.height))),
  };

  const inset = (on: boolean) => (on ? 1 : 0);

  const width = Math.max(
    0,
    Math.floor(rect.width) - inset(borders.left) - inset(borders.right),
  );

  const height = Math.max(
    0,
    Math.floor(rect.height) - inset(borders.top) - inset(borders.bottom),
  );

  return {
    x: Math.floor(rect.x) + inset(borders.left),
    y: Math.floor(rect.y) + inset(borders.top),
    // Herdr keeps the scrollbar lane on panes wider than four cells.
    columns: chrome.paneScrollbars && width > 4 ? width - 1 : width,
    rows: height,
  };
};

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

  if (!layout) return null;
  const chrome = yield* host.chrome;
  const surface = paneSurface(layout, paneId, chrome);

  if (!surface || surface.columns < 1 || surface.rows < 1) return null;
  const { columns, rows } = surface;

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
            column: left + surface.x,
            row: top + surface.y,
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
