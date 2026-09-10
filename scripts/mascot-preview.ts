import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Resvg } from "@resvg/resvg-js";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { MascotError, Pack } from "../src/services/mascot";

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assets = path.resolve(import.meta.dir, "../assets");
  const directories = (yield* fs.readDirectory(assets))
    .filter((directory) => /-(pixel|illustrated)$/.test(directory))
    .sort();
  if (directories.length === 0)
    return yield* new MascotError({
      message: "No bundled mascot packs found.",
    });

  const rows: string[] = [];
  let columns = 0;
  for (const [row, directory] of directories.entries()) {
    const pack = yield* Schema.decodeEffect(Schema.fromJsonString(Pack))(
      yield* fs.readFileString(path.join(assets, directory, "mascot.json")),
      { onExcessProperty: "error" },
    );
    const files = [
      ...new Set([...pack.idle, ...pack.jump].map((frame) => frame.file)),
    ];
    columns = Math.max(columns, files.length);
    const cells: string[] = [];
    for (const [column, file] of files.entries()) {
      const svg = yield* fs.readFileString(
        path.resolve(assets, directory, file),
      );
      const renderer = yield* Effect.try({
        try: () =>
          new Resvg(svg, {
            font: { loadSystemFonts: false },
          }),
        catch: (cause) =>
          new MascotError({
            message: `Could not render ${directory}/${file}`,
            cause,
          }),
      });
      if (renderer.width <= 0 || renderer.width !== renderer.height)
        return yield* new MascotError({
          message: `${directory}/${file} must have a square viewBox`,
        });
      const x = 215 + column * 160;
      const y = row * 180 + 12;
      cells.push(
        `<svg x="${x}" y="${y}" width="128" height="128" viewBox="0 0 ${renderer.width} ${renderer.height}">${svg}</svg>`,
        `<text x="${x}" y="${y + 152}" fill="#abb8c4" font-size="13" font-family="sans-serif">${escapeXml(file)}</text>`,
      );
    }
    rows.push(
      `<text x="16" y="${row * 180 + 24}" fill="#e6edf3" font-size="16" font-family="sans-serif">${escapeXml(pack.name)}</text>`,
      ...cells,
    );
    yield* Console.log(`${directory}: ${files.length} frames`);
  }

  const width = 215 + columns * 160;
  const height = directories.length * 180;
  const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#20252e"/>${rows.join("")}</svg>`;
  const png = yield* Effect.try({
    try: () => new Resvg(sheet).render().asPng(),
    catch: (cause) =>
      new MascotError({
        message: "Could not render the mascot preview",
        cause,
      }),
  });
  yield* fs.writeFile(path.join(assets, "mascot-packs.png"), png);
  yield* fs.writeFileString(path.join(assets, "mascot-packs.svg"), sheet);
  yield* Console.log(
    "Updated assets/mascot-packs.png and assets/mascot-packs.svg",
  );
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
