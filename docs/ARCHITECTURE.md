# Architecture map

One local DSH bundle, no build step. The host half is a set of small ES
modules; the client half is one classic-script file because the DSH module
loader cannot load local imports. The public behavior is documented in
`README.md` / `README.zh.md`.

## Host half

Everything host-side uses `ctx.*`; no `@deepseek-ai/*` imports. Host modules
import the launcher layer only through `launcher.js` and the data layer through
`github.js`. A new host or launcher module must be added to `package.json`
`files` (`host/*.js`, `launcher/*.js` globs) and is linted by the same rules.

- `index.js` — `apply(ctx, config)`: settings normalization, wiring of the
  `host/` factories, the exact web routes, the `triage_desk` tool and the
  system-prompt section. It keeps its public exports (`apply`, `inject`,
  `name`, `createSnapshotCache`, `shouldCacheSnapshot`, `hasTransientWarnings`).
  `wire(config, previous)` builds the settings and the `host/` factories,
  keeping the parts whose inputs a save left unchanged. An `internal/update`
  listener applies a saved config through it without restarting the plugin and
  falls back to the restart when wiring throws.
- `host/` — one responsibility per module, each a factory over `{ ctx,
  settings, platform, log, … }` where it needs plugin state:
  - `snapshot-cache.js` — `createSnapshotCache` (single flight, queued forced
    refresh, `retire` for a replaced cache, `raceAbort` so a cancelled caller
    never cancels the shared build), `shouldCacheSnapshot`,
    `hasTransientWarnings`;
  - `snapshot.js` — `createSnapshotStore`: build, adaptive TTL on low quota,
    the per-source `profiles` Map passed to every build (pull level and
    `large`; the new store of a GitHub settings change starts empty), and the stale fallback (a
    failed build serves the previous snapshot as `stale` with
    `meta.lastError`; a store a save replaced hands over its snapshot as that
    fallback until the new store caches a build);
  - `config.js` — `EDITABLE_FIELDS`, `sanitizePatch`, `publicConfig` (adds
    `detectedAgents[id].draft` from `draftCommandForStatus`);
  - `processes.js` — `createProcesses`: `runProcess`, executable lookup,
    clipboard, `openTerminal(scriptPath, title, signal, choice)` (resolves the
    saved terminal choice, falling back to Automatic when it is not installed;
    focus-or-reuse an existing tab, else open a tab in the shared window with a
    window fallback; the result carries `terminal: { id, label, fallback }`),
    `startLinuxTerminal` (acknowledges an emulator still running after 500 ms
    instead of waiting for it), `detectTerminals` (the platform catalog with
    what is installed and what Automatic resolves to), `detectPasteSupport`
    (`{ available, reason, python }`: Python 3 with `pty` on macOS/Linux —
    `xcode-select -p` is checked before `/usr/bin/python3`, which is only an
    installer stub without the Command Line Tools — and ConPTY, build 17763+,
    on Windows), and `wmctrl`·`xdotool` detection. Terminal emulators and
    `python3` share one cached login-shell lookup (`locateTools`);
  - `agents.js` — `createAgents`: `detectAgents` (one login-shell probe for all
    agents, absolute paths only; a Windows command path is reported resolved,
    and every found Windows agent also carries a `shim` verdict from
    `isWindowsShim` on that path, of which only `shim: false` allows the draft;
    `publicConfig` keeps it on the host) and `discoverAgents`;
  - `clones.js` — `createClones`: clone directories and scans, workspace
    fallback, native directory picker, `resolveClone`;
  - `launch.js` — `createLaunch`: scenario/agent resolution,
    `renderScenarioPrompt`, `launchForItem` (runs the detected path through
    `withAgentExecutable`, detecting again with `force` when the cached path
    is gone, and on macOS/Linux passes its directory as `binDir`; picks the
    delivery mode — `draft` when `draftCommandForStatus` returns a command for
    that (possibly fresh) status, `paste` when `promptDelivery` is `paste` and
    `detectPasteSupport` allows it, else `clipboard` with
    `delivery.pasteBlocked` naming the reason; the clipboard always gets a
    copy), temp directories, `openLoginTerminal`;
  - `gh.js` — `createGh`: `gh`/`git` resolution and auth status;
  - `http.js`, `errors.js`, `tool-text.js` — JSON body/response helpers,
    `BadRequest`/`LaunchError`, and the tool's text rendering.
- `github.js` — `gh` runner and GraphQL queries, `buildSnapshot`, section
  classification, warnings/rate-limit metadata, settings normalization. Query
  operations: `ViewerSources` (viewer and up to 11 memberships, so the
  10-organization cap `MAX_ORGS` can report `orgs-truncated`), `PullSearch`
  (one per source at pull level 0: team membership and the
  `review-requested:`/`reviewed-by:`/`author:` PR searches), `IssueSearch` (one
  per source: assigned issues, new issues, mentions; a failure only adds
  `search-unavailable`), `PullSearchPage` (one page of one search: follow-up
  pages, and every page on pull levels 1 and 2, then `prs-truncated`),
  `BranchScan` (repositories without PRs, `REPO_PAGE_SIZE` 100 ×
  `MAX_REPO_PAGES` 3, then `repos-truncated`), and for a large source
  `ContributedRepos` (once per build) and `BranchScanRepo` (one per
  contributed repository, at most `MAX_CONTRIBUTED_REPOS` 10, branches whose
  name contains the viewer login; `branch-scan-narrowed`). Phases run
  round-robin across sources: every source's pull searches and `IssueSearch`,
  then PR pages by page number, then branch pages.
  `PULL_LEVELS` is the ladder for sources GitHub cannot serve: a GraphQL
  request past GitHub's ~10 s server limit answers `HTTP 502`/`504` or an
  empty body, classified as the `gateway-timeout` GhError and retried once by
  `ghGraphql` like `failed`. A pull search that still fails that way, or with
  `too-large`, steps the source one level down (level 1: each search on its
  own, 10 × 5 pages; level 2: 5 × 5 pages with smaller comment windows; the
  first split page of a source also reads team membership), records
  `source-degraded`, and keeps the level in its profile. A source is large
  when it stepped down or its branch scan was overloaded (kept in the profile),
  or when its new-issue search counts more than `LARGE_NEW_ISSUES` (500, that
  build only); a large source shows no new unassigned issues
  (`new-issues-skipped`, only when some are in repositories the viewer
  maintains) and gets the narrow branch scan (the repositories of the viewer's
  PRs found in the source, then `ContributedRepos`).
  `canStartQuery` is the only quota gate: it stops at a reported rate limit or
  `MIN_RATE_REMAINING` (100) and records `scan-budget`; there is no per-refresh
  point budget. A failed query loses only its own results: a source whose pull
  searches all failed still shows its issues and branch CI. A source counts as
  scanned once one of its pull searches succeeded; when no source is scanned
  `buildSnapshot` throws. Searches use the
  viewer login only; `meLogins` classify ownership, requests and activity on
  the PRs found and do not expand discovery. Cost estimates per query are in
  the comments next to the query texts.
- `launcher.js` — the launcher layer's public entry: named re-exports only.
  Names it does not re-export are internal to `launcher/`. Modules:
  - `agent-command.js` — `commandWords` (static word decoding with raw spans),
    `agentExecutable`, `hasSafePromptPlaceholder` and its one user-facing
    wording `AGENT_COMMAND_RULE`, `shellQuote`, and the command variants
    (`bareAgentCommand`, `buildDraftCommand`, and `withAgentExecutable`, the
    one pin of the detected executable; Windows uses `windowsPin`, see
    [REFERENCE.md](REFERENCE.md#agents)), and `draftCommandForStatus`, the one
    decision whether a launch uses the native draft, taken from a detection
    status for both the launch and the launch menu (on Windows only for a
    pinned `.exe` that is not a known shim, never a `.cmd`/`.bat` that
    `cmd.exe` would re-parse). `{prompt}` appears once, unquoted, after an
    executable word, either
    as a whole word or directly after `-x=`/`--flag=`; backticks, `$(`, `${`,
    unquoted `; & | < > ( )` and word-initial `#` are rejected. The host is the
    only implementation of this rule;
  - `agents.js` — presets, discoverable CLIs, `normalizeAgentConfig` returning
    `{ agents, invalidAgents }` (rejected saved agents are reported, never
    launched; presets apply only when no saved agent is valid);
  - `executable-probe.js` — `buildExecutableProbe` / `parseExecutableProbe` /
    `classifyProbeAnswer`: zsh `whence -p` and bash `type -P`, both under
    `-lic`, other shells `command -v`; an alias to one absolute path resolves to
    it, other aliases and functions yield `reason: 'alias' | 'function'`;
  - `windows-shims.js` — `isWindowsShim(path, io?)`: true when a Windows
    `.exe`, or the target a symlink or junction resolves to, is in a known shim
    layout (Scoop, bun, Chocolatey, Volta, mise, proto), when a link resolves
    to something other than an `.exe`, or when a marker or link cannot be
    checked; such an `.exe` gets no native draft. A best effort over the listed
    managers;
  - `scenarios.js` and `prompt.js` — built-in scenarios, normalization and
    validation, section/reason labels, and prompt rendering (item tokens,
    section `{links}` block, safe trimming);
  - `settings.js` — `normalizeLauncherConfig` (also `terminal`, via
    `normalizeTerminalChoice`, and `promptDelivery`: `paste` | `clipboard`);
  - `terminals.js` — `TERMINAL_CATALOG` per platform (`id`, `label`, whether a
    launch opens a tab, macOS app bundles or Linux/Windows executable names),
    `TERMINAL_IDS`, `normalizeTerminalChoice`;
  - `paste-wrapper.js` — the paste wrapper that types a prompt into an agent's
    input box: `PASTE_WRAPPER_PY` (Python 3 `pty`, macOS/Linux) and
    `PASTE_WRAPPER_CS` (C# over ConPTY, compiled by PowerShell 5.1 `Add-Type`),
    one state machine with shared constants (`PASTE_QUIET_MS`,
    `PASTE_SETTLE_MS`, `PASTE_DEADLINE_MS`, `PASTE_TRUST_PATTERN`): ready once
    the agent turns bracketed paste on and its output is quiet or has settled, a
    folder-trust dialog holds the paste until the user presses Enter, then one
    bracketed paste with no Enter. `sanitizePastePrompt` strips control
    characters (keeps newline and tab) so the prompt cannot end the paste early.
    `dev/smoke-paste.mjs` checks both implementations against a fake agent; CI
    runs it on ubuntu, Windows (inside `npm run check`) and macOS;
  - `clones.js` and `repo-urls.js` — `scanCloneDirs` (per-root budget, symlinks
    followed once by realpath), `parseGitConfigRemotes` / `remoteToRepo` (all
    GitHub remotes, scp form with or without a user), `parseSshConfigHosts` /
    `readSshHostAliases` (literal `Host` aliases whose `HostName` is GitHub),
    `chooseCloneRepo` (upstream, origin, first GitHub remote), `matchClone`,
    `lookupRepoPath` (case-insensitive `repoPaths`);
  - `posix-scripts.js`, `windows-scripts.js`, `terminal-plan.js` — POSIX and
    PowerShell 5.1 launcher/login scripts (draft, paste, clipboard and login
    variants), `openTerminalPlan(platform, capabilities)` (macOS `app`:
    iTerm2 or Ghostty tab, Terminal.app window; shared-window tabs on
    Windows/Linux; `wt: ''` asks for a plain PowerShell window),
    `focusTerminalPlan(platform, capabilities)` (best-effort raise-by-title
    for focus-or-reuse in iTerm2, Ghostty, wmctrl/xdotool; `null` when
    unsupported), and
    `buildItermTabAppleScript` / `buildGhosttyTabAppleScript` (Ghostty 1.4
    AppleScript dictionary);
  - `common.js` — small shared helpers.

Useful route boundaries: `GET /triage-desk/snapshot`, `POST /triage-desk/launch`,
`POST /triage-desk/prompt`, `POST /triage-desk/agents/find`,
`GET|POST /triage-desk/config`, `GET /triage-desk/clones`,
`POST /triage-desk/pick-directory`, `POST /triage-desk/pick-clone`,
`GET /triage-desk/auth`, `POST /triage-desk/auth/login`. Custom routes are fenced
with `ctx.connection.requestRejection`.

## Client half

`client.js` is one classic-script bundle (`window.__ModuleLoader__.load`).
Navigate it by these symbol names rather than by line numbers; read a window
around the symbol and extend the symbol's neighbourhood instead of dumping the
whole file.

- store and polling in `createStore`: subscriber-owned visibility listener
  (reload when the tab becomes visible), interval rescheduling, one recovery
  slot shared by the transient retry and `scheduleErrorRetry`
  (`ERROR_RETRY_SECONDS` 15/60/300, each capped by the poll interval), and a
  save generation protecting confirmed settings/cadence from older in-flight
  config/snapshot reads (a snapshot read started before a save is followed by a
  fresh one). `reloadAfterSave` is the panel's read after a confirmed save; its
  first failure is retried once after `SAVE_RELOAD_RETRY_MS`.
  `confirmAccepted` handles an older running host that answers a save with 202:
  the status becomes `applying` and the config is read back after the restart;
- `staleDetail` puts the current failure (`meta.lastError`) into the stale banner;
- snooze lives in the store (`snoozed`, `snooze(item, until?)` returning the
  replaced entry, `setSnooze(id, entry)` for Undo, `unsnooze(id)`), persisted
  under the localStorage key `triage-desk:snoozed:v2` as
  `{ id: { fingerprint, until, at } }`; an unavailable storage falls back to
  memory. `activeSnooze(snoozed, item, now)`
  is the one rule: the fingerprint (`updatedAt`, or a branch's `commit`)
  matches and `until` is null or later than `now`. `pruneSnoozed` drops
  expired and changed entries on any snapshot, missing items only after an
  `ok` one; `scheduleSnoozeExpiry` keeps one timer at the earliest `until`
  while a slot is mounted, so the badge and the list update on time.
  `snoozeChoices` (new activity, tomorrow / next Monday at `SNOOZE_HOUR`) and
  `formatSnoozeTime` (Intl, UI language from the `snooze.locale` dictionary
  key) feed the snooze popover (`snoozeMenu`, opened through `openMenu`:
  `'snooze:' + rowStateKey` for a row, `'snooze-section:' + id` for a section
  header, `'snooze:selection'` for the bar), the Undo toast
  (`showToast(text, tone, { label, run })`) and the Snoozed view
  (`filter: 'snoozed'`, `filterBeforeSnoozed` to return to). Bulk actions go
  through `setSnoozes(changes)` (one update, returns the replaced entries),
  `snoozeItems(items, until)` / `unsnoozeIds(ids)`, and `bulkSnooze` /
  `bulkUnsnooze` show one toast whose Undo passes the replaced entries back
  to `setSnoozes`;
- Select mode lives in the store (`selectMode`, `selected: { id: true }`,
  `selectionAnchor: { section, id }`): `Section` owns the Shift-range logic
  behind a stable `onSelect` for its memoized rows and the tri-state header
  checkbox (`selectCheckbox`, a role=checkbox button); `Row` in the mode adds
  the checkbox column, selects on row click and renders the title as text, and
  hides its action buttons. `Page` derives `visibleItems` / `selectedItems`
  from the visible rows, prunes ids it no longer shows, clears the selection
  on filter/source/search changes, leaves the mode on Escape (unless a menu is
  open) and renders `SelectionBar`, whose bulk actions end the mode;
- `attentionSummary(sections, snoozed, matches?, now?)` is the one attention
  counter: `total` is each actionable item once by `id`, without snoozed items
  and review items marked `optional` by the host; `repeats`, `optional`,
  `snoozed` and `issues` say what it leaves out, each pull request in one
  category. `PanelIcon` (global badge only: DSH's panel button owns the
  label, tooltip and accessible name) and the page total (source filter,
  `AttentionCount` tooltip: hover, focus, Escape in the capture phase) use it;
  section chips and the
  *Snoozed* chip count the visible rows (source filter and search);
- `PanelIcon` for `sidebar.panellist`;
- `Page` for the `main` slot, with `Section` and memoized `Row`; `Page` owns the
  minute tick (`now` prop for relative times) and the Settings leave guard
  (`leaveSettings`, Discard / Keep editing, fed by `SettingsView`'s `dirtyRef`).
  Row and section terminal buttons render scenario menus (`launch.*`
  dictionaries); per-row menu/copy state is keyed by `rowStateKey(section,
  item)`, so a PR listed in two sections has independent rows. The section menu
  counts the union of its bound sections' visible, non-snoozed items. The row
  snooze popover reuses the launch-menu look and `useLaunchMenu`;
- `SettingsView` for the settings form, the launch-scenario editor
  (`renderScenarios`) with a live prompt preview (`scenarioPreviewText`), the
  agent editor with the **Find agents** scan, `config.invalidAgents` loaded as
  editable rows flagged invalid (with a summary warning), and the GitHub connection card; native picker
  completions merge through functional form updates, and manual clone mapping
  syntax is validated before a save request is sent;
- `launchDsh` in the row/section menus asks `POST /triage-desk/prompt` for the
  rendered text and opens a new chat through the DSH client service
  `uiWorkspace.startSession(undefined, { prompt, whenDraftExists: 'append' })`,
  so the prompt is a draft, not a submitted turn. It is only offered when
  `config.supportsPrompt` is true; the same gate pattern hides **Find agents**
  behind `config.supportsAgentDiscovery`;
- shared launch-menu pieces: `useLaunchMenu` (outside click that ignores the
  trigger, Escape with focus return, optional first-item focus and upward
  flip), `launchTargetPicker`, `launchScenarioItem`, `startDshDraft`, and
  `effectiveReason(item)` for the re-review reason. The client does not parse
  agent commands: the host validates them on save and answers an invalid one
  with `error.code: 'invalid-agent'` and the agent id, which flags that row.

Only `react` may be required. All CSS classes are prefixed `adx-`; UI strings come
from the `triage-desk` locale dictionaries (EN/ZH; English is the default).

## Shared contracts

Changing a setting usually touches all of:

`config` field → `normalizeSettings` / `normalizeLauncherConfig` → SettingsView
form/save payload → EN/ZH dictionaries → `README.md` + `README.zh.md` config
table → `CHANGELOG.md` (and screenshots if visible controls changed).

Launch scenarios are a nested array: `scenarios` (id, label, scope, sections,
prompt, agent, enabled) plus `defaultScenario`. `agent` is either `default` or a
configured agent id; the row and section menus pick the actual agent per launch
(an explicit `agent` in the launch body wins, a pinned scenario agent is used
otherwise). The client sends `POST /triage-desk/launch` with `scenario` and
either one row (`url`, row fields) or a section union (`section`, `urls`); the
host renders the prompt from the snapshot and returns `scenario`, `count`,
`trimmed`, `cwdMode` alongside the base launch fields.

`publicConfig` also advertises client-facing capabilities (`supportsPrompt`,
`supportsAgentDiscovery`); every new client-to-host route should be gated the same
way so an older running host never receives a request it cannot answer. Additive
fields the client reads with a fallback for an older host: `invalidAgents`,
`labels: { sections, reasons }` (prompt preview labels, otherwise raw codes),
`terminal`, `promptDelivery`, `terminals` (detectTerminals; null hides the
terminal picker), `promptPaste` (detectPasteSupport; null means unknown and the
launch menu assumes the clipboard), `platform` (paste keys in hints and toasts),
the launch result's `terminal` and `delivery: { mode, pasteBlocked, platform }`,
`detectedAgents[id].executable`, `detectedAgents[id].draft` (whether the
launch uses the native draft; absent → the agent's draft flag decides, except
on `win32`, where absent means no draft), review
items' `optional` flag (absent → counted), and the optional `{ commands }` body
of `POST /triage-desk/agents/find` (the host leaves out agents whose executable
is already configured; an oversized or non-JSON body is a 400; an older host
ignores the body and the client compares exact commands and the program word).

Snapshot sections are fixed: `review`, `rereview`, `merge`, `respond`, `ci`,
`issues`. Keep the host response shape and client expectations in sync.

## Verification

- `npm run check` — deterministic default gate.
- `npm run smoke:host` — live GitHub/network, opt-in; never wire it into CI.
- `dev/smoke-snapshot.mjs` runs `buildSnapshot` and the host cache against a
  fake `gh` that answers by GraphQL operation name (`ViewerSources`,
  `PullSearch`, `IssueSearch`, `PullSearchPage`, `BranchScan`) and rejects queries with
  unused or undeclared variables; add a case there when changing section
  classification, pagination, quota limits or snapshot failure handling.
- `POST /triage-desk/config` returns 200 only after `configEditor.edit` resolves,
  that is, after the profile write and the loader's `fiber.update`; failures
  return 500 with `save-failed`. Client success requires this confirmation, and
  edits made during a pending save remain dirty.
- `dev/smoke-client.mjs` covers store lifetimes, polling, the error-retry
  schedule and visibility handling with fake timers.
- `dev/smoke-render.mjs` renders the real client with a fixture, including the
  settings screen and capability-gated menus, and drives settings flows, the
  minute tick and menu interactions through a deterministic hook runner; add
  assertions there when changing `Page`/`Section`/`Row`/`SettingsView` props or
  visibility rules.
- Local profile install, reload, and duplicate-loader checks: `docs/DEV_LOCAL.md`.
