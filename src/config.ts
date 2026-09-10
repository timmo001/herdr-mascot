import { createHash } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

export const pluginId = "timmo.mascot";
export const layerId = "timmo-mascot";

export class ConfigError extends Schema.TaggedError<ConfigError>()(
  "ConfigError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const Settings = Schema.Struct({
  animationDelayMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5_000 })),
  ),
  sizePixels: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 16, maximum: 256 })),
  ),
  position: Schema.optionalKey(
    Schema.Literals(["bottom-right", "bottom-left", "top-right", "top-left"]),
  ),
  mascot: Schema.optionalKey(Schema.NonEmptyString),
});

export type Position = NonNullable<typeof Settings.Type.position>;

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
  return {
    settings,
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
    readonly position: Position;
    readonly mascotFile: string;
  }
>()("herdr-mascot/Preferences") {
  static readonly layer = Layer.effect(
    Preferences,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const path = yield* Path.Path;
      const { settings, revision } = yield* loadSettings(config.settingsFile);
      return Preferences.of({
        revision,
        animationDelayMs: settings.animationDelayMs ?? 0,
        sizePixels: settings.sizePixels ?? 64,
        position: settings.position ?? "bottom-right",
        mascotFile: settings.mascot
          ? path.resolve(config.configDir, settings.mascot)
          : path.join(config.root, "assets/pixel-cat/mascot.json"),
      });
    }),
  );
}
