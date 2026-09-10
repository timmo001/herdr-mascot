import type { PaneGraphicsFrameEncoded } from "@herdr/sdk";
import type { Position } from "./config";
import type { Target } from "./services/herdr";
import type { Frame } from "./services/mascot";

export function frameAt(frames: readonly [Frame, ...Frame[]], elapsed: number) {
  const duration = frames.reduce((total, frame) => total + frame.durationMs, 0);
  let time = Math.max(0, elapsed) % duration;
  for (const frame of frames) {
    if (time < frame.durationMs) return frame;
    time -= frame.durationMs;
  }
  return frames[0];
}

export function restingPosition(
  target: Target,
  size: number,
  position: Position,
) {
  const width = target.columns * target.cellWidth;
  const height = target.rows * target.cellHeight;
  const fitted = Math.min(size, width, height);
  return {
    size: fitted,
    x: position.endsWith("right") ? width - fitted : 0,
    y: position.startsWith("bottom") ? height - fitted : 0,
  };
}

export function jumpPosition(
  target: Target,
  destination: {
    readonly x: number;
    readonly y: number;
    readonly size: number;
  },
  progress: number,
) {
  const t = Math.max(0, Math.min(1, progress));
  const travel = t * t * (3 - 2 * t);
  const lift = Math.min(
    destination.size * 0.45,
    target.rows * target.cellHeight - destination.size,
  );
  const direction = destination.y > 0 ? -1 : 1;
  const startX = target.columns * target.cellWidth;
  return {
    x: startX + (destination.x - startX) * travel,
    y: destination.y + direction * lift * 4 * t * (1 - t),
  };
}

export function sameTarget(left: Target | null, right: Target | null) {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.paneId === right.paneId &&
      left.tabId === right.tabId &&
      left.workspaceId === right.workspaceId &&
      left.x === right.x &&
      left.y === right.y &&
      left.columns === right.columns &&
      left.rows === right.rows &&
      left.cellWidth === right.cellWidth &&
      left.cellHeight === right.cellHeight)
  );
}

export function graphicsFrame(
  frame: Frame,
  target: Target,
  x: number,
  y: number,
  size: number,
): PaneGraphicsFrameEncoded {
  const left = Math.round(x);
  const top = Math.round(y);
  const cellWidth = target.cellWidth;
  const cellHeight = target.cellHeight;
  const col = Math.max(
    0,
    Math.min(target.columns - 1, Math.floor(left / cellWidth)),
  );
  const row = Math.max(
    0,
    Math.min(target.rows - 1, Math.floor(top / cellHeight)),
  );
  const endCol = Math.min(target.columns, Math.ceil((left + size) / cellWidth));
  const endRow = Math.min(target.rows, Math.ceil((top + size) / cellHeight));
  const gridCols = Math.max(1, endCol - col);
  const gridRows = Math.max(1, endRow - row);
  const width = gridCols * cellWidth;
  const height = gridRows * cellHeight;
  const data = new Uint8Array(width * height * 4);
  for (let dy = 0; dy < height; dy++) {
    const sy = Math.floor(
      ((row * cellHeight + dy - top) * frame.height) / size,
    );
    if (sy < 0 || sy >= frame.height) continue;
    for (let dx = 0; dx < width; dx++) {
      const sx = Math.floor(
        ((col * cellWidth + dx - left) * frame.width) / size,
      );
      if (sx < 0 || sx >= frame.width) continue;
      const source = (sy * frame.width + sx) * 4;
      data.set(
        frame.pixels.subarray(source, source + 4),
        (dy * width + dx) * 4,
      );
    }
  }
  return {
    format: "rgba",
    imageWidth: width,
    imageHeight: height,
    data,
    placement: { viewportCol: col, viewportRow: row, gridCols, gridRows },
  };
}
