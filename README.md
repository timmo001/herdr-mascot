# Herdr Mascot

An original greyscale pixel-art cat that follows your active Herdr pane. It breathes,
blinks and hops when you switch panes, tabs or workspaces.

The mascot uses a named graphics layer over the existing terminal. It takes no
keyboard focus and opens no extra panes. SVG frames are rasterised once when the
renderer starts, then sent through `@herdr/sdk` as RGBA images.

## Requirements

- Linux or macOS
- Herdr 0.9.0 with protocol 22, as required by the pinned SDK
- A terminal with Kitty graphics support and cell-pixel size reporting
- mise, using the Bun and Node versions pinned in `mise.toml`

Pane graphics must be enabled in Herdr. The mascot waits while its pane is hidden
or cell-pixel dimensions are unavailable. Herdr can temporarily hide graphics
while you select text or use its menus.

## Local setup

From this checkout:

```sh
mise run install
mise run build
herdr plugin link "$PWD"
herdr plugin action invoke timmo.mascot.start
```

The startup hook also starts the mascot on the next Herdr server start. Showing
it repeatedly keeps one renderer per session. Each session has its own lease and
log directory under `HERDR_PLUGIN_STATE_DIR`.

```sh
herdr plugin action invoke timmo.mascot.stop
herdr plugin action invoke timmo.mascot.start
herdr plugin config-dir timmo.mascot
```

To show or hide the mascot with one action:

```sh
herdr plugin action invoke timmo.mascot.toggle
```

Bind it in Herdr's `config.toml`, then run `herdr server reload-config`:

```toml
[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "timmo.mascot.toggle"
description = "toggle mascot"
```

Press your Herdr prefix, then `t`. After updating an existing local link, run
`herdr plugin link "$PWD"` again to register the new action.

`stop` asks the renderer to hop out and waits for its lease to be released. Its
scoped graphics stream removes only the mascot's layer. Showing the mascot
again, or starting a new server, clears the stopped state.

## Configuration

Create `config.json` in the directory printed by `herdr plugin config-dir`:

```json
{
  "sizePixels": 64,
  "position": "bottom-right",
  "animationDelayMs": 0
}
```

| Setting            | Default           | Meaning                                                                                                                           |
| ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sizePixels`       | `64`              | Width and height in pixels, from 16 to 256. Small panes reduce it to fit.                                                         |
| `animationDelayMs` | `0`               | Delay before each entry or exit hop, from 0 to 5,000 milliseconds. Zero starts immediately.                                       |
| `position`         | `"bottom-right"`  | `bottom-right`, `bottom-left`, `top-right`, `top-left`, `center-bottom`, `center-top`, `random`, `bottom-random` or `top-random`. |
| `mascot`           | Bundled pixel cat | Path to a replacement pack's `mascot.json`, absolute or relative to the config directory.                                         |

There is one mascot, attached to the active pane. Positioning leaves room for
pane borders and the scrollbar. Workspace-wide and session-wide drawing are not
configuration modes.

Valid config changes and rebuilt `dist/index.js` are picked up after roughly
four seconds. An invalid config is logged and the current renderer keeps
running until the config is fixed. The hide action still works with an invalid
config. A replacement pack must be valid when the new renderer starts.

### Focus changes

- With `"position": "random"`, each entry chooses one of the six positions with
  equal probability. `bottom-random` chooses from `bottom-left`, `center-bottom`
  and `bottom-right`; `top-random` chooses from `top-left`, `center-top` and
  `top-right`. Switching panes, tabs or workspaces picks again, as does
  invoking `start`, even while the mascot is shown. Repeated choices are possible.
  The cat exits from its current position before entering at the new one, using
  the same hop animations and left-side mirroring. Resizing keeps the chosen position.
- Entries and exits independently choose the corner's horizontal or vertical
  edge with a 50/50 chance: left/up for
  top-left, right/up for top-right, left/down for bottom-left and right/down for
  bottom-right. Both directions have an equal chance, including on toggle-off.
- `center-bottom` and `center-top` sit halfway across the pane and use only the
  bottom or top edge respectively for both entry and exit.
- Each hop varies in height and speed. Entries take 80-120% of the pack's jump
  duration; exits take 200-300ms. Random choices stay fixed throughout each hop.
- Focus and stop notifications wake the renderer immediately. `animationDelayMs`
  adds an optional pause before each hop without changing its speed.
- Herdr hides inactive tabs and workspaces immediately, so the outgoing hop is
  only visible while the old pane remains on screen.
- Fast switches interrupt the entry hop, exit from its current position and
  follow the latest focused pane without queuing intermediate switches.
- Resizing adjusts the cat's position and size without queuing another hop.

Drawing stays inside the active pane. The cat does not draw across dividers or
the sidebar, and a hop entering from an edge is clipped there.

## Mascot packs

The default pack lives in [`assets/pixel-cat/`](assets/pixel-cat/).
Its five SVGs were drawn for this project and share the project's Apache-2.0
licence. They are ordinary standalone assets you can reuse or replace.

The artwork uses a 16×16 grid with crisp edges. The default 64px size gives each
source pixel a 4×4 block; multiples of 16 give evenly sized blocks.
The original smooth cat is still available in
[`assets/greyscale-cat/`](assets/greyscale-cat/). Set `mascot` to that pack's
absolute `mascot.json` path to use it.

To make another mascot, copy that directory somewhere you maintain and point
`mascot` at its manifest:

```json
{
  "sizePixels": 80,
  "position": "bottom-left",
  "mascot": "mascots/my-cat/mascot.json"
}
```

A minimal pack looks like this:

```text
my-cat/
├── mascot.json
├── idle.svg
└── jump.svg
```

```json
{
  "version": 1,
  "name": "My cat",
  "idle": [{ "file": "idle.svg", "durationMs": 1000 }],
  "jump": [{ "file": "jump.svg", "durationMs": 500 }]
}
```

- Both animation lists need 1 to 32 frames.
- Each frame lasts 30 to 10,000 milliseconds.
- Files resolve relative to the manifest.
- Use square, self-contained SVGs with transparent backgrounds. Keep the same
  viewBox and alignment across frames.
- `idle` loops. `jump` plays once per entry or exit, with frame timing scaled to
  the hop's randomly chosen duration.
- Use frame sequences for animation. SVG scripts, CSS animation and SMIL are not
  the animation mechanism.
- Hide and show the mascot after editing the pack's SVGs or manifest.

The bundled artwork is greyscale; replacement packs can use colour.

Set `"flipOnLeft": true` in a pack's `mascot.json` to mirror its artwork
horizontally at `top-left` and `bottom-left`, including entry and exit frames.
This is enabled for both bundled cats and defaults to `false` for other packs.
Centre and right positions use the original orientation.

## Development

```sh
mise run install
mise run format
mise run check
mise run build
bun dist/index.js --help
```

`watch` runs the renderer in the foreground with Herdr's plugin environment.
The normal `start` action detaches it and sends output to the session's
`watch.log` under `HERDR_PLUGIN_STATE_DIR`. Plugin action and startup failures
also appear in Herdr's plugin command logs.

This project started as a copy of `herdr-workflow-watch`. It keeps its Effect v4
CLI, Bun/mise tooling, singleton lease, config reload and CI. GitHub polling,
workflow indicators, pickers and agent launchers have been removed.

The Bun patch points the SDK's package export at upstream TypeScript source,
which Bun bundles into `dist/index.js`. `@resvg/resvg-js` stays external to the
bundle so its platform-specific native module loads from `node_modules`.

### Manual check

To preview all six positions in the active Herdr session:

```sh
mise run test-options
```

This builds and refreshes the local plugin link, then invokes the runtime
`test-options` command. Once registered, you can also run it directly:

```sh
herdr plugin action invoke timmo.mascot.test-options
```

It shows an entry and exit at each position, with three seconds on screen and a short gap
between positions. The cycle runs in the background for roughly 25 seconds.
Corners keep their random 50/50 directions; rerun to see different hops.

The command temporarily sets `animationDelayMs` to zero, then restores the original
config and shown/hidden state on completion or failure. Keep this session focused
while watching. Progress and any errors appear in the plugin logs:

```sh
herdr plugin log list --plugin timmo.mascot --limit 1
```

After linking and showing the plugin:

1. Confirm the cat appears at the configured size and corner with a transparent
   background, blinking and breathing while the terminal remains usable.
2. Switch between differently placed panes, then between tabs or workspaces.
   Check that entries use either adjacent edge of the configured corner.
   Centre positions should enter and exit vertically through their matching edge.
3. Switch rapidly, resize and zoom. Confirm there is only one cat, it stays
   within the active pane and fits a small pane.
4. Select text and open a Herdr menu. Confirm normal input still works.
5. Change the size, corner or pack in `config.json` and confirm it reloads.
6. Hide or toggle off the mascot and confirm it hops out before the image clears.
   Try each corner and check that exits use its two adjacent edges, with varied
   height and speed. Show it again and disable the plugin to check cleanup.

Interactive behaviour is checked by the owner, rather than automated UX tests.
