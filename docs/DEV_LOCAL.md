# Local plugin development

This package is normally developed as a **local bundle linked into a DSH profile**,
not installed from npm. The profile loads it on every host boot; the panel and the
agent tool are the verification surface.

## What runs where

- **Host half** (`index.js`, `launcher.js`, `github.js`) runs inside the DSH host
  process. It is read when the DSH host starts. Editing host files does **not**
  hot-reload them: restart DSH after a host change.
- **Client half** (`client.js`) is a plain browser bundle loaded by the panel. A
  page refresh picks changes up. HMR also needs the client bundle watcher running;
  an active HMR receiver alone does not establish automatic rebuild/reload.

There is no build step and no `dist/` directory: the files in this repository are
what the profile loads.

## Install shape

The profile lives under `$DSH_HOME/profiles/<profile>/`:

- `package.json` — a `link:` dependency on this directory and
  `dsh-triage-desk` inside `dsh.profile.bundles`;
- `cordis.patch.yml` — optional per-entry overrides (disable rows, config);
- `node_modules/dsh-triage-desk` — a symlink back to this repository.

A marketplace can load the same package a second time through a profile-scoped
hot-mount layer (`<profile>/.dsh-market/hot-*.yml`, row ids prefixed `mkt-`).
Both loaders register the same exact HTTP routes, so a second instance fails with
`webserver: duplicate exact route "/triage-desk/snapshot"`. Keep exactly one
loader for the plugin: either the profile bundle or a temporary hot mount, never
both.

## Reload procedure

1. **Quit and reopen DeepSeek Harness** after host changes. A full host restart
   releases the old exact routes and the old plugin instance.
2. Do **not** use `plugin_manager` enable/disable as a reload substitute. It
   removes the loader entry but can leave the old HTTP routes owned until the host
   restarts; the next enable then fails with a duplicate route and the panel and
   `triage_desk` tool disappear.
3. If a client-only change was made, a page refresh is enough; if the panel did
   not update, refresh the page once more after the host is back.

## Inspecting the installation

Use read-only checks before changing the profile:

- `plugin_manager list_plugins` — paged, 200+ entries, the `target` argument is
  not a filter for listing. Look for `include:triage-desk` (profile bundle) and
  `include:dsh-market:mkt-*` (hot mount).
- `<profile>/package.json` — the `link:` dependency and `dsh.profile.bundles`.
- `<profile>/cordis.patch.yml` — disable/enable rows and saved config.
- `<profile>/.dsh-market/hot-*.yml` — ephemeral hot-mount rows.
- `<profile>/.dsh-market/log.ndjson` — enable/disable and hot-mount history.

## Verification

`npm run check` is the deterministic gate. It does not exercise a live DSH host,
a real terminal, or clicking the panel:

- `smoke:render` renders the real client with a fixture and exercises settings
  callbacks through a deterministic hook runner; it is not a browser/DOM test;
- `smoke:client` tests subscriber lifetimes, visibility changes and polling with
  fake timers; `smoke:launcher` checks platform adapters without opening terminals;
- `smoke:host` is opt-in and touches the real GitHub CLI;
- UI/menu changes also need a manual screenshot from the panel (launch it from
  the sidebar, exercise the control, compare with the previous behavior).

When a host change is ready, restart DSH, refresh the page, and verify the panel
before reporting the change as done.
