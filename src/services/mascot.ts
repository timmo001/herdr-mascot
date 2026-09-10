import { Resvg } from "@resvg/resvg-js";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { Preferences } from "../config";

export class MascotError extends Schema.TaggedError<MascotError>()(
  "MascotError",
  { message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

const Frames = Schema.NonEmptyArray(
  Schema.Struct({
    file: Schema.NonEmptyString,
    durationMs: Schema.Int.check(
      Schema.isBetween({ minimum: 30, maximum: 10_000 }),
    ),
  }),
).check(Schema.isMaxLength(32));

export const Pack = Schema.Struct({
  version: Schema.Literal(1),
  name: Schema.NonEmptyString,
  flipOnLeft: Schema.optionalKey(Schema.Boolean),
  idle: Frames,
  jump: Frames,
});

export type Frame = {
  readonly pixels: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
};

export class Mascot extends Context.Service<
  Mascot,
  {
    readonly name: string;
    readonly flipOnLeft: boolean;
    readonly size: number;
    readonly idle: readonly [Frame, ...Frame[]];
    readonly jump: readonly [Frame, ...Frame[]];
  }
>()("herdr-mascot/Mascot") {
  static readonly layer = Layer.effect(
    Mascot,
    Effect.gen(function* () {
      const config = yield* Preferences;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const pack = yield* Schema.decodeEffect(Schema.fromJsonString(Pack))(
        yield* fs.readFileString(config.mascotFile),
        { onExcessProperty: "error" },
      );
      const cache = new Map<string, Omit<Frame, "durationMs">>();
      const load = Effect.fn("Mascot.loadFrame")(function* (
        frame: (typeof Frames.Type)[number],
      ) {
        const file = path.resolve(path.dirname(config.mascotFile), frame.file);
        let image = cache.get(file);
        if (!image) {
          const svg = yield* fs.readFileString(file);
          image = yield* Effect.try({
            try: () => {
              const renderer = new Resvg(svg, {
                fitTo: { mode: "width", value: config.sizePixels },
                font: { loadSystemFonts: false },
              });
              if (renderer.width <= 0 || renderer.width !== renderer.height)
                throw new Error(`${frame.file} must have a square viewBox`);
              const result = renderer.render();
              return {
                pixels: result.pixels,
                width: result.width,
                height: result.height,
              };
            },
            catch: (cause) =>
              new MascotError({
                message: `Could not render ${frame.file}`,
                cause,
              }),
          });
          cache.set(file, image);
        }
        return { ...image, durationMs: frame.durationMs };
      });
      const idle = yield* Effect.forEach(pack.idle, load);
      const jump = yield* Effect.forEach(pack.jump, load);
      return Mascot.of({
        name: pack.name,
        flipOnLeft: pack.flipOnLeft ?? false,
        size: config.sizePixels,
        idle,
        jump,
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new MascotError({
            message:
              "Could not load the mascot pack. Check its manifest and SVG frames.",
            cause,
          }),
      ),
    ),
  );
}
