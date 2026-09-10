import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command } from "effect/unstable/cli";
import { version } from "../package.json";
import { start, stop, toggle, watch } from "./commands/watch";
import { Preferences, RuntimeConfig, pluginId } from "./config";
import { reportError } from "./errors";
import { Mascot } from "./services/mascot";
import { herdrLayer } from "./services/herdr";
import { Process } from "./services/process";

const platform = RuntimeConfig.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
);
const application = Layer.mergeAll(Process.layer, herdrLayer).pipe(
  Layer.provideMerge(platform),
);
const preferences = Preferences.layer.pipe(Layer.provideMerge(application));
const renderer = Mascot.layer.pipe(Layer.provideMerge(preferences));

Command.make("herdr-mascot").pipe(
  Command.withDescription("An animated mascot for the active Herdr pane"),
  Command.withSubcommands([
    Command.make("start", {}, () =>
      start.pipe(Effect.provide(application)),
    ).pipe(Command.withDescription("Show the mascot in this session")),
    Command.make("stop", {}, () => stop.pipe(Effect.provide(platform))).pipe(
      Command.withDescription(
        "Hide the mascot and release its graphics layers",
      ),
    ),
    Command.make("toggle", {}, () =>
      toggle.pipe(Effect.provide(application)),
    ).pipe(Command.withDescription("Show or hide the mascot in this session")),
    Command.make("watch", {}, () => watch.pipe(Effect.provide(renderer))).pipe(
      Command.withDescription("Run the mascot in the foreground"),
    ),
  ]),
  Command.run({ version }),
  Effect.tapCause((cause) => reportError(cause)),
  Effect.annotateLogs({ plugin: pluginId }),
  Effect.provide(
    Layer.merge(NodeServices.layer, Logger.layer([Logger.consoleJson])),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
