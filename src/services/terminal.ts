import { deflateSync } from "node:zlib";
import { Context, Effect, Layer, Queue, Schema, Stream } from "effect";

export class TerminalError extends Schema.TaggedError<TerminalError>()(
  "TerminalError",
  { message: Schema.String },
) {}

export type Geometry = {
  readonly columns: number;
  readonly rows: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
};

export type Image = {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly column: number;
  readonly row: number;
  readonly columns: number;
  readonly rows: number;
};

// In-band size reports: CSI 48 ; rows ; columns ; height px ; width px t
// oxlint-disable-next-line no-control-regex -- reports start with ESC
const sizeReport = /\x1b\[48;(\d+);(\d+);(\d+);(\d+)t/g;

const graphics = (control: string, payload = "") =>
  `\x1b_G${control}${payload ? `;${payload}` : ""}\x1b\\`;

const clearImages = graphics("a=d,d=A,q=2");

const placement = (image: Image, id: number) => {
  const payload = deflateSync(image.data).toString("base64");
  const chunks = payload.match(/.{1,4096}/g) ?? [""];

  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;

      return index === 0
        ? graphics(
            `a=T,f=32,o=z,s=${image.width},v=${image.height},i=${id},p=1,c=${image.columns},r=${image.rows},C=1,q=2,m=${more}`,
            chunk,
          )
        : graphics(`m=${more}`, chunk);
    })
    .join("");
};

export class Terminal extends Context.Service<
  Terminal,
  {
    readonly geometry: Effect.Effect<Geometry | null>;
    readonly resized: Stream.Stream<void>;
    readonly draw: (image: Image) => Effect.Effect<void, TerminalError>;
    readonly clear: Effect.Effect<void, TerminalError>;
  }
>()("herdr-mascot/Terminal") {
  static readonly layer = Layer.effect(
    Terminal,
    Effect.gen(function* () {
      const { stdin, stdout } = process;

      if (!stdin.isTTY || !stdout.isTTY)
        return yield* new TerminalError({
          message: "The mascot renderer must run inside its Herdr pane.",
        });

      const write = (data: string) =>
        Effect.callback<void, TerminalError>((resume) => {
          stdout.write(data, (error) =>
            resume(
              error
                ? Effect.fail(new TerminalError({ message: String(error) }))
                : Effect.void,
            ),
          );
        });

      const resized = yield* Queue.sliding<void>(1);
      let geometry: Geometry | null = null;
      let pending = "";

      const onData = (chunk: Buffer) => {
        pending = (pending + chunk.toString("latin1")).slice(-256);
        let end = 0;

        for (const match of pending.matchAll(sizeReport)) {
          const [rows, columns, height, width] = match.slice(1).map(Number);
          end = match.index + match[0].length;

          if (!rows || !columns || !height || !width) continue;
          geometry = {
            columns,
            rows,
            cellWidth: Math.floor(width / columns),
            cellHeight: Math.floor(height / rows),
          };
          Queue.offerUnsafe(resized, undefined);
        }

        const partial = pending.lastIndexOf("\x1b");
        pending = partial >= end ? pending.slice(partial) : "";
      };

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          stdin.setRawMode(true);
          stdin.on("data", onData);
          stdin.resume();
        }).pipe(
          // Alternate screen, hidden cursor, then in-band size reports.
          Effect.andThen(write("\x1b[?1049h\x1b[?25l\x1b[?2048h")),
        ),
        () =>
          write(`${clearImages}\x1b[?2048l\x1b[?25h\x1b[?1049l`).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.sync(() => {
                stdin.off("data", onData);
                stdin.setRawMode(false);
                stdin.pause();
              }),
            ),
          ),
      );

      let current = 0;

      const draw = Effect.fn("Terminal.draw")(function* (image: Image) {
        const previous = current;
        current = previous === 1 ? 2 : 1;

        // Place the new image before deleting the old one, in one synchronised update.
        yield* write(
          `\x1b[?2026h\x1b[${image.row + 1};${image.column + 1}H${placement(image, current)}${
            previous ? graphics(`a=d,d=I,i=${previous},q=2`) : ""
          }\x1b[?2026l`,
        );
      });

      return Terminal.of({
        geometry: Effect.sync(() => geometry),
        resized: Stream.fromQueue(resized),
        draw,
        clear: write(clearImages),
      });
    }),
  );
}
