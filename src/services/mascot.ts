import { Resvg } from "@resvg/resvg-js";
import {
  Cache,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
} from "effect";
import { SaxesParser } from "saxes";
import { Preferences } from "../config";
import { containsPath } from "../paths";

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

export type LoadedMascot = {
  readonly name: string;
  readonly flipOnLeft: boolean;
  readonly size: number;
  readonly idle: readonly [Frame, ...Frame[]];
  readonly jump: readonly [Frame, ...Frame[]];
};

export class Mascot extends Context.Service<
  Mascot,
  {
    readonly get: (file: string) => Effect.Effect<LoadedMascot, MascotError>;
  }
>()("herdr-mascot/Mascot") {
  static readonly layer = Layer.effect(
    Mascot,
    Effect.gen(function* () {
      const config = yield* Preferences;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const files = new Set([
        config.mascotFile,
        ...config.directoryMascots.map((rule) => rule.mascotFile),
      ]);
      const read = Effect.fn("Mascot.readPackFile")(function* (
        file: string,
        roots: ReadonlyArray<string>,
        extension: string,
      ) {
        const resolved = yield* fs.realPath(file);
        if (
          !roots.some((root) => containsPath(root, resolved)) ||
          path.extname(resolved) !== extension
        )
          return yield* new MascotError({
            message: `Pack file must be a ${extension} inside its allowed directory: ${file}`,
          });
        const info = yield* fs.stat(resolved);
        if (info.type !== "File" || info.size > 1_048_576)
          return yield* new MascotError({
            message: `Pack files must be regular files no larger than 1 MiB: ${file}`,
          });
        return { file: resolved, contents: yield* fs.readFileString(resolved) };
      });
      const loadPack = Effect.fn("Mascot.loadPack")(
        function* (mascotFile: string) {
          const manifest = yield* read(mascotFile, config.assetRoots, ".json");
          const pack = yield* Schema.decodeEffect(Schema.fromJsonString(Pack))(
            manifest.contents,
            { onExcessProperty: "error" },
          );
          const directory = path.dirname(manifest.file);
          const cache = new Map<string, Omit<Frame, "durationMs">>();
          const load = Effect.fn("Mascot.loadFrame")(function* (
            frame: (typeof Frames.Type)[number],
          ) {
            const file = path.resolve(directory, frame.file);
            let image = cache.get(file);
            if (!image) {
              const { contents: svg } = yield* read(file, [directory], ".svg");
              image = yield* Effect.try({
                try: () => {
                  // Parse before resvg: its native resolver can read local images.
                  const parser = new SaxesParser({ xmlns: true });
                  parser.on("doctype", () => {
                    throw new Error("SVG document types are not allowed");
                  });
                  parser.on("processinginstruction", () => {
                    throw new Error(
                      "SVG processing instructions are not allowed",
                    );
                  });
                  parser.on("opentag", (tag) => {
                    if (tag.local === "script" || tag.local === "foreignObject")
                      throw new Error("Only static SVG artwork is allowed");
                    for (const attribute of Object.values(tag.attributes)) {
                      if (
                        attribute.local.startsWith("on") ||
                        (attribute.uri ===
                          "http://www.w3.org/XML/1998/namespace" &&
                          attribute.local === "base")
                      )
                        throw new Error(
                          "SVG event handlers and base URLs are not allowed",
                        );
                      if (attribute.local !== "href") continue;
                      const embeddedPng =
                        /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(
                          attribute.value,
                        );
                      const fragment =
                        tag.local !== "image" &&
                        /^#[^\s]+$/.test(attribute.value);
                      if (!embeddedPng && !fragment)
                        throw new Error(
                          "SVG references must be local fragments or embedded PNG images",
                        );
                    }
                  });
                  parser.write(svg).close();
                  const renderer = new Resvg(svg, {
                    fitTo: { mode: "width", value: config.sizePixels },
                    font: { loadSystemFonts: false },
                  });
                  if (renderer.width <= 0 || renderer.width !== renderer.height)
                    throw new Error(`${frame.file} must have a square viewBox`);
                  const result = renderer.render();
                  const pixels = result.pixels;
                  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
                    pixels[alpha] = Math.round(
                      (pixels[alpha] * config.opacity) / 100,
                    );
                  }
                  return {
                    pixels,
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
          return {
            name: pack.name,
            flipOnLeft: pack.flipOnLeft ?? false,
            size: config.sizePixels,
            idle,
            jump,
          };
        },
        Effect.mapError(
          (cause) =>
            new MascotError({
              message:
                "Could not load the mascot pack. Check its manifest and SVG frames.",
              cause,
            }),
        ),
      );
      const cache = yield* Cache.make({
        capacity: files.size,
        lookup: loadPack,
      });
      yield* Effect.forEach(files, (file) => Cache.get(cache, file));
      return Mascot.of({
        get: Effect.fn("Mascot.get")(function* (file) {
          if (!files.has(file))
            return yield* new MascotError({
              message: "Mascot is not configured",
            });
          return yield* Cache.get(cache, file);
        }),
      });
    }),
  );
}
