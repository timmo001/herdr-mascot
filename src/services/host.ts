import { dlopen, FFIType, ptr } from "bun:ffi";
// oxlint-disable-next-line timmo-effect/prefer-platform-services -- Effect FileSystem cannot pass O_NOCTTY when opening a client tty
import { closeSync, constants, openSync, write } from "node:fs";
import { homedir } from "node:os";
import { deflateSync } from "node:zlib";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { RuntimeConfig } from "../config";

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

// A Herdr client attached to this session, drawn on through its own terminal.
export type Client = {
  readonly tty: string;
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

// The parts of Herdr's client layout that move the pane surface.
export type Chrome = {
  readonly tabBarBottom: boolean;
  readonly mobileWidthThreshold: number;
};

const HerdrConfig = Schema.Struct({
  ui: Schema.optionalKey(
    Schema.Struct({
      tab_bar_position: Schema.optionalKey(Schema.Literals(["top", "bottom"])),
      mobile_width_threshold: Schema.optionalKey(Schema.Int),
    }),
  ),
});

// Well above Herdr's own host image ids (10000 to 910000).
const imageIds = [1_835_103_075, 1_835_103_076] as const;

const TIOCGWINSZ = 0x5413;

const graphics = (control: string, payload = "") =>
  `\x1b_G${control}${payload ? `;${payload}` : ""}\x1b\\`;

const remove = (id: number) => graphics(`a=d,d=I,i=${id},q=2`);

const placement = (image: Image, id: number) => {
  const payload = deflateSync(image.data).toString("base64");
  const chunks = payload.match(/.{1,4096}/g) ?? [""];

  return chunks
    .map((chunk, index) => {
      const more = index < chunks.length - 1 ? 1 : 0;

      return index === 0
        ? graphics(
            `a=T,f=32,o=z,s=${image.width},v=${image.height},i=${id},p=1,c=${image.columns},r=${image.rows},z=1000,C=1,q=2,m=${more}`,
            chunk,
          )
        : graphics(`m=${more}`, chunk);
    })
    .join("");
};

const writeAll = (fd: number, data: string) =>
  Effect.callback<void, HostError>((resume) => {
    const buffer = Buffer.from(data, "latin1");

    const next = (offset: number) =>
      write(fd, buffer, offset, buffer.length - offset, null, (error, size) => {
        if (error)
          resume(Effect.fail(new HostError({ message: String(error) })));
        else if (offset + size < buffer.length) next(offset + size);
        else resume(Effect.void);
      });

    next(0);
  });

export class Host extends Context.Service<
  Host,
  {
    readonly clients: Effect.Effect<ReadonlyArray<Client>, HostError>;
    readonly chrome: Effect.Effect<Chrome>;
    readonly draw: (tty: string, image: Image) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("herdr-mascot/Host") {
  static readonly layer = Layer.effect(
    Host,
    Effect.gen(function* () {
      const config = yield* RuntimeConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const clientSocket = path.join(
        path.dirname(config.socket),
        `${path.basename(config.socket, path.extname(config.socket))}-client.sock`,
      );

      const herdrConfig =
        process.env.HERDR_CONFIG_PATH ??
        path.join(
          process.env.XDG_CONFIG_HOME ?? path.join(homedir(), ".config"),
          "herdr",
          "config.toml",
        );

      const libc = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            dlopen("libc.so.6", {
              ioctl: {
                args: [FFIType.i32, FFIType.u64, FFIType.ptr],
                returns: FFIType.i32,
              },
            }),
          catch: (cause) =>
            new HostError({ message: `Could not load libc: ${String(cause)}` }),
        }),
        (library) => Effect.sync(() => library.close()),
      );

      const terminals = new Map<string, { fd: number; image?: number }>();
      let chrome: Chrome = { tabBarBottom: false, mobileWidthThreshold: 64 };
      let discoveredAt = Number.NEGATIVE_INFINITY;

      const forget = (tty: string) =>
        Effect.sync(() => {
          const terminal = terminals.get(tty);

          if (!terminal) return;
          terminals.delete(tty);
          closeSync(terminal.fd);
        });

      const readChrome = Effect.gen(function* () {
        if (!(yield* fs.exists(herdrConfig))) return;
        const contents = yield* fs.readFileString(herdrConfig);

        const parsed = yield* Effect.try(() => Bun.TOML.parse(contents)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HerdrConfig)),
        );

        chrome = {
          tabBarBottom: parsed.ui?.tab_bar_position === "bottom",
          mobileWidthThreshold: parsed.ui?.mobile_width_threshold ?? 64,
        };
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not read the Herdr config", cause),
        ),
      );

      // Clients are the peers of Herdr's client socket; each draws on its own tty.
      const discover = Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("ss", ["-xpn"], { stdin: "ignore" }),
          );

          const [stdout, code] = yield* Effect.all(
            [
              child.stdout.pipe(Stream.decodeText(), Stream.mkString),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );

          if (code !== 0)
            return yield* new HostError({
              message: `Could not list Herdr clients: ss exited ${code}`,
            });

          return stdout;
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            cause instanceof HostError
              ? cause
              : new HostError({
                  message: `Could not list Herdr clients: ${String(cause)}`,
                }),
          ),
        );

        // Columns: netid, state, queues, local address and inode, peer address and inode, users.
        const sockets = output
          .split("\n")
          .map((line) => line.trim().split(/\s+/));

        const peers = new Set(
          sockets
            .filter((columns) => columns[4] === clientSocket)
            .map((columns) => columns[7]),
        );

        const pids = new Set(
          sockets
            .filter((columns) => columns[5] && peers.has(columns[5]))
            .flatMap((columns) =>
              [
                ...columns
                  .slice(8)
                  .join(" ")
                  .matchAll(/pid=(\d+)/g),
              ].map((match) => match[1]),
            ),
        );

        const ttys = new Set<string>();

        for (const pid of pids)
          for (const fd of [0, 1, 2]) {
            const link = yield* fs
              .readLink(`/proc/${pid}/fd/${fd}`)
              .pipe(Effect.orElseSucceed(() => ""));

            if (/^\/dev\/(pts\/\d+|tty\w+)$/.test(link)) {
              ttys.add(link);
              break;
            }
          }

        for (const tty of terminals.keys())
          if (!ttys.has(tty)) yield* forget(tty);

        for (const tty of ttys)
          if (!terminals.has(tty))
            yield* Effect.try({
              // Without O_NOCTTY the detached renderer would adopt the tty.
              try: () =>
                terminals.set(tty, {
                  fd: openSync(tty, constants.O_WRONLY | constants.O_NOCTTY),
                }),
              catch: (cause) =>
                new HostError({
                  message: `Could not open ${tty}: ${String(cause)}`,
                }),
            }).pipe(Effect.catch((error) => Effect.logWarning(error.message)));

        yield* readChrome;
        discoveredAt = yield* Clock.currentTimeMillis;
      });

      const clients = Effect.gen(function* () {
        if (
          terminals.size === 0 ||
          (yield* Clock.currentTimeMillis) - discoveredAt > 5_000
        )
          yield* discover;
        const result: Array<Client> = [];

        for (const [tty, terminal] of terminals) {
          const size = new Uint16Array(4);

          if (libc.symbols.ioctl(terminal.fd, TIOCGWINSZ, ptr(size)) !== 0)
            continue;
          const [rows = 0, columns = 0, width = 0, height = 0] = size;

          // Without pixel sizes the mascot cannot be scaled to the cell grid.
          if (!rows || !columns || !width || !height) continue;
          result.push({
            tty,
            columns,
            rows,
            cellWidth: Math.floor(width / columns),
            cellHeight: Math.floor(height / rows),
          });
        }

        return result;
      });

      const send = (tty: string, data: string) =>
        Effect.gen(function* () {
          const terminal = terminals.get(tty);

          if (!terminal) return;
          yield* writeAll(terminal.fd, data).pipe(
            Effect.catch(() => forget(tty)),
          );
        });

      // Place the new image before removing the old one, leaving Herdr's cursor as it was.
      const draw = Effect.fn("Host.draw")(function* (
        tty: string,
        image: Image,
      ) {
        const terminal = terminals.get(tty);

        if (!terminal) return;
        const previous = terminal.image;
        const current = previous === imageIds[0] ? imageIds[1] : imageIds[0];
        terminal.image = current;
        yield* send(
          tty,
          `\x1b7\x1b[${image.row + 1};${image.column + 1}H${placement(image, current)}${
            previous ? remove(previous) : ""
          }\x1b8`,
        );
      });

      const clear = Effect.gen(function* () {
        for (const [tty, terminal] of terminals) {
          if (!terminal.image) continue;
          terminal.image = undefined;
          yield* send(tty, imageIds.map(remove).join(""));
        }
      });

      yield* Effect.addFinalizer(() =>
        clear.pipe(
          Effect.andThen(
            Effect.forEach([...terminals.keys()], forget, { discard: true }),
          ),
        ),
      );

      return Host.of({
        clients,
        chrome: Effect.sync(() => chrome),
        draw,
        clear,
      });
    }),
  );
}
