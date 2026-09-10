import { NodeServices } from "@effect/platform-node";
import { Resvg } from "@resvg/resvg-js";
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { Effect, FileSystem, Layer, Path } from "effect";
import {
  Preferences,
  RuntimeConfig,
  loadSettings,
  mascotForDirectory,
} from "../src/config";
import { Mascot } from "../src/services/mascot";

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="8" height="8" fill="red"/></svg>';
const manifest = (file: string) =>
  JSON.stringify({
    version: 1,
    name: "Fixture",
    idle: [{ file, durationMs: 100 }],
    jump: [{ file, durationMs: 100 }],
  });

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const configDir = path.join(root, "config");
  const pack = path.join(configDir, "pack");
  yield* fs.makeDirectory(pack, { recursive: true });
  yield* fs.makeDirectory(path.join(root, "assets"));
  yield* fs.writeFileString(
    path.join(pack, "mascot.json"),
    manifest("idle.svg"),
  );
  yield* fs.writeFileString(path.join(pack, "idle.svg"), svg);
  yield* fs.writeFileString(
    path.join(configDir, "config.json"),
    JSON.stringify({ mascot: "pack/mascot.json" }),
  );
  const runtime = RuntimeConfig.of({
    socket: path.join(root, "socket"),
    root,
    state: root,
    configDir,
    settingsFile: path.join(configDir, "config.json"),
  });
  return { fs, path, root, pack, runtime };
});

test("directory selection uses boundaries and the most specific rule", () =>
  Effect.gen(function* () {
    const { fs, runtime } = yield* fixture;
    yield* fs.writeFileString(
      runtime.settingsFile,
      JSON.stringify({
        directoryMascots: [
          { path: "~/projects", mascot: "parent/mascot.json" },
          { path: "~/projects/nested/", mascot: "nested/mascot.json" },
        ],
      }),
    );
    const preferences = yield* Preferences.pipe(
      Effect.provide(
        Preferences.layer.pipe(
          Layer.provide(Layer.succeed(RuntimeConfig, runtime)),
        ),
      ),
    );
    expect(mascotForDirectory(`${homedir()}/projects`, preferences)).toEndWith(
      "parent/mascot.json",
    );
    expect(
      mascotForDirectory(`${homedir()}/projects/nested/src`, preferences),
    ).toEndWith("nested/mascot.json");
    expect(
      mascotForDirectory(`${homedir()}/projects-backup`, preferences),
    ).toBe(preferences.mascotFile);
    expect(
      mascotForDirectory(`${homedir()}/projects/../other`, preferences),
    ).toBe(preferences.mascotFile);
    expect(mascotForDirectory(undefined, preferences)).toBe(
      preferences.mascotFile,
    );
    for (const rules of [
      [{ path: "relative", mascot: "pack/mascot.json" }],
      [
        { path: "/same", mascot: "pack/mascot.json" },
        { path: "/same/", mascot: "pack/mascot.json" },
      ],
    ]) {
      yield* fs.writeFileString(
        runtime.settingsFile,
        JSON.stringify({ directoryMascots: rules }),
      );
      expect(
        (yield* loadSettings(runtime.settingsFile).pipe(Effect.result))._tag,
      ).toBe("Failure");
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  ));

test("Stow config links authorise their source packs and preserve cached pixels", () =>
  Effect.gen(function* () {
    const { fs, path, root, pack, runtime } = yield* fixture;
    const live = path.join(root, "live");
    const png = new Resvg(svg).render().asPng().toString("base64");
    yield* fs.writeFileString(
      path.join(pack, "idle.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image width="16" height="16" href="data:image/png;base64,${png}"/></svg>`,
    );
    yield* fs.makeDirectory(live);
    yield* fs.symlink(runtime.settingsFile, path.join(live, "config.json"));
    const preferences = Preferences.layer.pipe(
      Layer.provide(
        Layer.succeed(RuntimeConfig, {
          ...runtime,
          configDir: live,
          settingsFile: path.join(live, "config.json"),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Mascot;
      const first = yield* service.get(path.join(pack, "mascot.json"));
      expect(first.idle[0].pixels.some((byte) => byte !== 0)).toBe(true);
      expect(
        first.idle[0].pixels.some(
          (byte, index) => index % 4 === 3 && byte === 0,
        ),
      ).toBe(true);
      yield* fs.remove(path.join(pack, "idle.svg"));
      expect(yield* service.get(path.join(pack, "mascot.json"))).toBe(first);
      expect(
        (yield* service.get(path.join(root, "other.json")).pipe(Effect.result))
          ._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(Mascot.layer.pipe(Layer.provide(preferences))));
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  ));

test("pack loading rejects manifest and frame escapes, including symlinks", () =>
  Effect.gen(function* () {
    const { fs, path, root, pack, runtime } = yield* fixture;
    const preferences = Preferences.layer.pipe(
      Layer.provide(Layer.succeed(RuntimeConfig, runtime)),
    );
    const load = Mascot.pipe(
      Effect.provide(Mascot.layer.pipe(Layer.provide(preferences))),
      Effect.result,
    );
    yield* fs.writeFileString(path.join(root, "outside.svg"), svg);
    yield* fs.symlink(
      path.join(root, "outside.svg"),
      path.join(pack, "escape.svg"),
    );
    for (const file of [
      "../../outside.svg",
      path.join(root, "outside.svg"),
      "escape.svg",
    ]) {
      yield* fs.writeFileString(path.join(pack, "mascot.json"), manifest(file));
      expect((yield* load)._tag).toBe("Failure");
    }
    yield* fs.writeFileString(
      path.join(root, "outside.json"),
      manifest("outside.svg"),
    );
    yield* fs.symlink(
      path.join(root, "outside.json"),
      path.join(pack, "escape.json"),
    );
    for (const file of ["../outside.json", "pack/escape.json"]) {
      yield* fs.writeFileString(
        runtime.settingsFile,
        JSON.stringify({ mascot: file }),
      );
      expect((yield* load)._tag).toBe("Failure");
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  ));

test("SVG parsing rejects external references and executable markup before rendering", () =>
  Effect.gen(function* () {
    const { fs, path, pack, runtime } = yield* fixture;
    const preferences = Preferences.layer.pipe(
      Layer.provide(Layer.succeed(RuntimeConfig, runtime)),
    );
    const load = Mascot.pipe(
      Effect.provide(Mascot.layer.pipe(Layer.provide(preferences))),
      Effect.result,
    );
    const bodies = [
      '<image href="/tmp/external.png" width="16" height="16"/>',
      '<image href="&#47;tmp/external.png" width="16" height="16"/>',
      '<image xmlns:x="http://www.w3.org/1999/xlink" x:href="file:///tmp/external.png"/>',
      '<image href="https://example.invalid/image.png"/>',
      '<image href="#external.png"/>',
      '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
      '<script>throw new Error("executed")</script>',
      '<rect onload="alert(1)"/>',
      '<g xml:base="file:///tmp/"/>',
    ];
    for (const body of bodies) {
      yield* fs.writeFileString(
        path.join(pack, "idle.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">${body}</svg>`,
      );
      expect((yield* load)._tag).toBe("Failure");
    }
    yield* fs.writeFileString(
      path.join(pack, "idle.svg"),
      `<!DOCTYPE svg [<!ENTITY image SYSTEM "file:///tmp/external.png">]>${svg}`,
    );
    expect((yield* load)._tag).toBe("Failure");
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.runPromise,
  ));
