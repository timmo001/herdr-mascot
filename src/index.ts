import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger, Path } from "effect";
import { Command } from "effect/cli";
import { version } from "../package.json";
import { testOptions } from "./commands/test-options";
import { start, stop, toggle, watch } from "./commands/watch";
import { Preferences, RuntimeConfig, pluginId } from "./config";
import { reportError } from "./errors";
import { Mascot } from "./services/mascot";
import { herdrLayer } from "./services/herdr";

const platform = RuntimeConfig.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);

const application = herdrLayer.pipe(Layer.provideMerge(platform));

const preferences = Preferences.layer.pipe(Layer.provideMerge(application));

const renderer = Mascot.layer.pipe(Layer.provideMerge(preferences));

// The renderer owns its pane's terminal, so it logs to the session's state directory.
const rendererLog = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* RuntimeConfig;
    const path = yield* Path.Path;

    return Logger.layer([
      Logger.toFile(Logger.formatJson, path.join(config.state, "watch.log"), {
        flag: "a",
        mode: 0o600,
      }),
    ]);
  }),
);

Command.make("herdr-mascot").pipe(
  Command.withDescription("An animated mascot for the active Herdr pane"),
  Command.withSubcommands([
    Command.make("start", {}, () =>
      start.pipe(Effect.provide(application)),
    ).pipe(Command.withDescription("Show the mascot in this session")),
    Command.make("stop", {}, () => stop.pipe(Effect.provide(platform))).pipe(
      Command.withDescription("Hide the mascot and close its pane"),
    ),
    Command.make("toggle", {}, () =>
      toggle.pipe(Effect.provide(application)),
    ).pipe(Command.withDescription("Show or hide the mascot in this session")),
    Command.make("test-options", {}, () =>
      testOptions.pipe(Effect.provide(preferences)),
    ).pipe(Command.withDescription("Preview all mascot positions")),
    Command.make("watch", {}, () =>
      watch.pipe(
        Effect.tapCause((cause) => reportError(cause)),
        Effect.provide(rendererLog.pipe(Layer.provideMerge(renderer))),
      ),
    ).pipe(Command.withDescription("Run the mascot in its Herdr pane")),
  ]),
  Command.run({ version }),
  Effect.tapCause((cause) => reportError(cause)),
  Effect.annotateLogs({ plugin: pluginId }),
  Effect.provide(
    Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson])),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
