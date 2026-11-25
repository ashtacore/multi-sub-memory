# Multi-Sub Memory desktop

The desktop app opens the shared dashboard in a sandboxed Electron window. It
starts its own dashboard server on a temporary loopback port and uses the
global database and user settings. The npm command
`npx multi-sub-memory ui` opens the browser dashboard independently.

## Run from source

From the repository root, using Node 24 or later:

```sh
npm ci
npm --prefix desktop ci
npm --prefix desktop start
```

Install Git on your PATH to verify local checkouts for Dreamer. Select a
project in **Dreamer** and choose **Checkout** when several directories are
available. See the [dashboard guide](../docs/wiki/Dashboard.md) for how the app
finds checkouts and which config it uses.

## Build a standalone app

Run the install commands above on the target platform and architecture so the
bundled optional native embedding dependencies match the target. Run the Windows
command on Windows for an NSIS installer and a portable executable, or the
Linux command on Linux for an AppImage.

```sh
npm --prefix desktop run dist -- --win
npm --prefix desktop run dist -- --linux
```

The build writes the artifacts to `desktop/dist/`. Running an artifact
requires no separate Node installation. On Linux, give the AppImage execute
permission before launching it.

The packages include Electron, the shared dashboard source and its installed
runtime dependencies. They use the same `~/.config/multi-sub-memory/config.yaml`
and SQLite database as the CLI. The window uses an isolated, sandboxed renderer
and only permits navigation on its own loopback origin. The local server drains
active requests and closes the database on exit.
