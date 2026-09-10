import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { containsPath } from "./paths";

export const pluginId = "timmo.mascot";
export const layerId = "timmo-mascot";

export const bottomCorners = ["bottom-right", "bottom-left"] as const;

export const topCorners = ["top-right", "top-left"] as const;

export const corners = [...bottomCorners, ...topCorners] as const;

export const bottomPositions = [...bottomCorners, "center-bottom"] as const;

export const topPositions = [...topCorners, "center-top"] as const;

export const positions = [...bottomPositions, ...topPositions] as const;

export type Position = (typeof positions)[number];

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const FilePath = Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/));

const DirectoryMascot = Schema.Struct({
  path: FilePath,
  mascot: FilePath,
});

const Settings = Schema.Struct({
  animationDelayMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 })),
  ),
  sizePixels: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 256 })),
  ),
  opacity: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  ),
  position: Schema.optionalKey(
    Schema.Literals([
      ...positions,
      "random",
      "bottom-random",
      "top-random",
      "random-corners",
      "bottom-random-corners",
      "top-random-corners",
    ]),
  ),
  mascot: Schema.optionalKey(FilePath),
  directoryMascots: Schema.optionalKey(Schema.Array(DirectoryMascot)),
});

const Environment = Schema.Struct({
  HERDR_SOCKET_PATH: Schema.NonEmptyString,
  HERDR_PLUGIN_ROOT: Schema.NonEmptyString,
  HERDR_PLUGIN_CONFIG_DIR: Schema.NonEmptyString,
  HERDR_PLUGIN_STATE_DIR: Schema.NonEmptyString,
});

export const loadSettings = Effect.fn("Config.loadSettings")(function* (
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = (yield* fs.exists(file))
    ? yield* fs.readFileString(file)
    : "{}";
  const settings = yield* Schema.decodeEffect(Schema.fromJsonString(Settings))(
    contents,
    { onExcessProperty: "error" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ConfigError({
          message: `Invalid config.json: ${cause.message}`,
          cause,
        }),
    ),
  );
  const directoryMascots: Array<{ path: string; mascot: string }> = [];
  for (const rule of settings.directoryMascots ?? []) {
    if (!path.isAbsolute(rule.path) && !rule.path.startsWith("~/"))
      return yield* new ConfigError({
        message: "Directory mascot paths must be absolute or start with ~/.",
      });
    const directory = rule.path.startsWith("~/")
      ? path.resolve(homedir(), rule.path.slice(2))
      : path.resolve(rule.path);
    if (directoryMascots.some((item) => item.path === directory))
      return yield* new ConfigError({
        message: `Duplicate directory mascot path: ${directory}`,
      });
    directoryMascots.push({ path: directory, mascot: rule.mascot });
  }
  return {
    settings,
    directoryMascots: directoryMascots.sort(
      (left, right) => right.path.length - left.path.length,
    ),
    revision: createHash("sha256").update(contents).digest("hex"),
  };
});

export class RuntimeConfig extends Context.Service<
  RuntimeConfig,
  {
    readonly socket: string;
    readonly root: string;
    readonly state: string;
    readonly configDir: string;
    readonly settingsFile: string;
  }
>()("herdr-mascot/Config") {
  static readonly layer = Layer.effect(
    RuntimeConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = yield* Schema.decodeUnknownEffect(Environment)(
        process.env,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ConfigError({
              message:
                "Herdr Mascot is missing its Herdr environment. Start it through the plugin.",
              cause,
            }),
        ),
      );
      const settingsFile = path.join(
        env.HERDR_PLUGIN_CONFIG_DIR,
        "config.json",
      );
      const state = path.join(
        env.HERDR_PLUGIN_STATE_DIR,
        createHash("sha256")
          .update(env.HERDR_SOCKET_PATH)
          .digest("hex")
          .slice(0, 20),
      );
      yield* fs.makeDirectory(state, { recursive: true, mode: 0o700 });
      return RuntimeConfig.of({
        socket: env.HERDR_SOCKET_PATH,
        root: env.HERDR_PLUGIN_ROOT,
        state,
        configDir: env.HERDR_PLUGIN_CONFIG_DIR,
        settingsFile,
      });
    }),
  );
}

export class Preferences extends Context.Service<
  Preferences,
  {
    readonly revision: string;
    readonly animationDelayMs: number;
    readonly sizePixels: number;
    readonly opacity: number;
    readonly position: NonNullable<typeof Settings.Type.position>;
    readonly mascotFile: string;
    readonly directoryMascots: ReadonlyArray<{
      readonly path: string;
      readonly mascotFile: string;
    }>;
    readonly assetRoots: ReadonlyArray<string>;
  }
>()("herdr-mascot/Preferences") {
  static readonly layer = Layer.effect(
    Preferences,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const { settings, directoryMascots, revision } = yield* loadSettings(
        config.settingsFile,
      );
      // Stow links files individually, so the config's source owns its packs.
      const configDir = (yield* fs.exists(config.settingsFile))
        ? path.dirname(yield* fs.realPath(config.settingsFile))
        : yield* fs.realPath(config.configDir);
      const assets = yield* fs.realPath(path.join(config.root, "assets"));
      return Preferences.of({
        revision,
        animationDelayMs: settings.animationDelayMs ?? 0,
        sizePixels: settings.sizePixels ?? 64,
        opacity: settings.opacity ?? 100,
        position: settings.position ?? "bottom-right",
        mascotFile: settings.mascot
          ? path.resolve(configDir, settings.mascot)
          : path.join(assets, "cat-pixel/mascot.json"),
        directoryMascots: directoryMascots.map((rule) => ({
          path: rule.path,
          mascotFile: path.resolve(configDir, rule.mascot),
        })),
        assetRoots: [configDir, assets],
      });
    }),
  );
}

export function mascotForDirectory(
  cwd: string | undefined,
  preferences: Preferences["Service"],
) {
  return (
    (cwd === undefined
      ? undefined
      : preferences.directoryMascots.find((rule) =>
          containsPath(rule.path, cwd),
        )?.mascotFile) ?? preferences.mascotFile
  );
}
