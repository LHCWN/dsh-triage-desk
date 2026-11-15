# Triage Desk

[![check](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml/badge.svg)](https://github.com/LHCWN/dsh-triage-desk/actions/workflows/check.yml)
[![npm version](https://img.shields.io/npm/v/dsh-triage-desk.svg)](https://www.npmjs.com/package/dsh-triage-desk)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that answers one question every morning: **what needs me right now?** It
turns GitHub activity into a single inbox panel — pull requests waiting for your
review or re-review, your own PRs that are ready to merge, PRs and mentions
needing an answer, failing CI, and new or assigned issues. Everything runs
locally through the GitHub CLI; the plugin never stores or forwards a token.

[简体中文](README.zh.md) · [Architecture](docs/ARCHITECTURE.md) · [Changelog](CHANGELOG.md)

**GitHub only.** Triage Desk reads pull requests, issues, reviews, and CI through
the signed-in GitHub CLI; GitLab, Bitbucket, Gitea, and other code hosts are not
supported.

If GitHub is not connected, the error notice has a **Sign in to GitHub** action;
Settings also shows whether `gh` is installed, which account is connected, and
offers the same login button.

## Features

- **Waiting for your review** — open PRs where your review is requested
  directly or through a team, and you have not reviewed the current head yet.
- **Re-review needed** — PRs you already reviewed whose head commit is no
  longer the one you reviewed (new commits, a rebase, or a force-push; matched
  by commit id, not by commit date), PRs where the author clicked **Re-request
  review** for you, or PRs where the author replied **to you** after your last
  action (a threaded reply to your review comment or an explicit @-mention). An
  author reply alone is secondary: it stays in the same section, muted and at
  the bottom, with the exact reason in the row tooltip. Other reviewers'
  activity alone does not ask you for another pass.
- **Ready to merge** — your PRs that are approved, mergeable, and (by default)
  green. PRs GitHub marks `BLOCKED` are excluded even when approval and checks pass.
- **Needs your action** — your PRs with requested changes, conflicts, or new
  reviewer comments (including inline review threads) that expect fixes, plus
  issues assigned to you and issues/PRs where you were mentioned and have not replied,
  including issues and PRs you authored yourself. A newer approval is not treated as
  "needs a reply": it moves the PR toward *Ready to merge* instead.
- **CI is failing** — red checks on your PRs and on branches, in personal and
  organization repositories: a red default branch of a repository you administer
  or maintain, and any red branch (the default one included) whose latest commit
  you (or a configured self alias) authored within the last week.
- **Issues** — new **unassigned** issues (opened in the last 30 days) in
  repositories you maintain, grouped under *New in your repositories* and styled quieter: they do not inflate the
  attention counter. Issues with an assignee are either your action (assigned to
  you, shown under *Needs your action*) or that person's work, so they never
  appear here. The 30-day window is fixed; snooze the issues you do not want
  to see.
- **Copy a link** — copy a single link from a row. The toolbar and section
  headers do not duplicate it; the one-place action keeps the toolbar compact.
- **Snooze** — the clock button on a row opens a small menu: *Until new
  activity* (the default), *Until tomorrow* (09:00 local time) or *Until next
  week* (Monday 09:00). The item leaves every section and the badge; any new
  activity on GitHub (a newer `updatedAt`, or a new commit for a branch) brings
  it back early, also for a timed snooze, and a timed snooze ends on time
  without a refresh. A toast confirms the snooze with *Undo* for about 6
  seconds. The *Snoozed (n)* chip after the section chips opens the snoozed
  items, dimmed, each with its return time and *Unsnooze*; it disappears when
  nothing is snoozed. Snoozes are kept in this browser's local storage
  (`triage-desk:snoozed:v2`) and are not
  synced between devices; entries for items that left the inbox are pruned
  after a complete refresh.
- **Bulk snooze** — the clock button in a section header snoozes every row the
  section shows (after the source filter and search) through the same menu;
  in the Snoozed view it becomes *Unsnooze all (n)*. For any subset, press
  *Select* next to the search field: every row gets a checkbox before its
  icon, a click anywhere on the row selects it instead of opening the link
  (Space on a focused checkbox works too; Shift+click selects a range within a
  section), each section header gets a select-all checkbox, and the row
  buttons step aside. A bar at the bottom offers *Snooze* (or *Unsnooze* in
  the Snoozed view), *Select all* / *Deselect all* and *Done*. A PR listed in
  two sections is one selected item. A filter, source or search change clears
  the selection but keeps the mode; Done, Escape or a finished bulk action
  leave it. One toast with one *Undo* covers the whole bulk action.
- **Honest counters** — the sidebar badge counts each item once (a PR in both
  *Needs your action* and *CI is failing* is one item), leaves out review
  requests that are optional because someone else's approval already
  satisfies the PR, and leaves out snoozed items and new unassigned issues.
  Section chips (and *Snoozed*) count the rows the list shows under the
  current source filter and search; the page total is the badge for the
  selected source.
- **Launch scenarios** — a terminal button on every row opens a menu with an
  agent picker and named, editable prompts. Built-ins cover reviewing a PR
  (only on rows awaiting review), re-reviewing after changes (only on re-review
  rows), fixing a PR, replying in a thread, and triaging an issue. Section
  headers have their own scenarios that launch **one** agent with the prepared
  list of every visible row — "Review everything awaiting me", "Fix my PRs",
  "Triage new issues", "Answer mentions" — with the same agent picker, and the
  prompt asks the agent to isolate each item in its own sub-agent.
- **Open in DSH** — the launch menu has a **DSH — this app** target: a scenario
  opens a new chat in this DSH window with the prompt already in the composer and
  **not sent**. No Terminal window is created; press Enter when ready.
- **Open in a terminal** — a scenario opens a terminal in the local clone of the
  repository and starts a coding agent (Claude Code, Codex, opencode, Gemini
  CLI, Cursor Agent, Antigravity, pi, or your own command) with the prompt
  prepared but **not sent**. Launches share one Triage Desk terminal window:
  macOS opens an iTerm2 tab when iTerm2 is installed, otherwise a new Terminal
  window; Windows Terminal and Linux emulators open a tab where supported.
  Re-launching the same agent on the same item focuses its tab where the
  terminal supports it. The window stays open with a shell after the agent
  exits.
- **Two UI languages: English and Chinese** — there is no language setting in
  the plugin; the panel follows the DSH interface language. Switch DSH to
  Chinese for the Chinese panel; every other interface language shows
  English.
- **Agent tool** — `triage_desk` returns the same snapshot to the agent, so
  "what needs my attention?" is answered from one source of truth. It can also
  open a terminal for a URL when you ask for it explicitly.
- **Connected sources** — GitHub personal repositories and up to 10 GitHub
  organizations the account belongs to (or an explicit list of up to 10). Each
  row carries its source, and a source filter narrows the list (and its counts)
  when more than one source is connected.
- **Settings in the panel** — organizations, personal repositories, auto-refresh
  interval, green-CI merge rule, bot-review handling, terminal agents, launch
  scenarios, and clone directories.

## Requirements

- DeepSeek Harness `0.2.2-rc.2` or newer.
- **GitHub only** — the plugin reads GitHub pull requests, issues, reviews, and
  CI through `gh`; GitLab, Bitbucket, Gitea, and other hosts are not supported.
- The GitHub CLI installed and signed in (`gh auth login`). The plugin runs `gh`
  on the host and never stores or forwards a token; private repositories need the
  `repo` scope that `gh auth login` normally grants. Settings shows the current
  connection, opens an interactive `gh auth login` in Terminal with the **Sign in
  to GitHub** button, and says explicitly when `gh` itself is not installed.
- A GitHub account with personal repositories and/or organization memberships.
  With an empty organization list the plugin auto-detects up to 10 organizations
  and includes the personal repositories it owns.

## Install

Triage Desk is a DSH **bundle**: DSH installs it into a profile and loads it as a
plugin. There is no build step, and the panel does not import anything from npm
at runtime.

### From npm

```sh
dsh plugin --profile <profile> add dsh-triage-desk
```

`<profile>` is the profile you run: `web` for `dsh web`, `desktop` for the
Desktop app. Restart DSH, refresh the page, and open the **Triage** entry in the
sidebar. The first run auto-detects the organization; the gear in the header
changes it. The package is also installable by name through Plugin Manager.

To update later:

```sh
dsh plugin --profile <profile> add dsh-triage-desk@latest
```

Then restart DSH.

### From a local checkout (development)

1. Clone the repository.
2. In DSH open **Plugins → Add plugin** and pick the repository directory, or run
   `dsh plugin --profile <profile> add ./dsh-triage-desk` from its parent folder.
3. Open the **Triage** entry in the sidebar.

After editing the host half, quit and reopen DSH, then refresh the page.
Client-only edits need a page refresh unless the client bundle watcher is running.
Do not toggle the plugin as a reload substitute; see
[local development](docs/DEV_LOCAL.md).

## Terminal launcher

Terminal settings (agents, launch scenarios, default scenario) are folded under
*Advanced*, together with the optional clone-search settings.

Every row with a GitHub link gets a terminal button. Clicking it opens a compact
menu: a **target picker** first (**DSH — this app** plus the installed terminal
agents), then the scenarios that apply to that row, the default scenario on top.
A scenario is a named prompt template; the built-ins are *Just the link*,
*Review this PR* (only on rows waiting for your review), *Re-review after
changes* (only on re-review rows), *Fix this PR*, *Reply in the thread*, and
*Triage this issue*. A scenario can pin its own terminal agent: it then shows
that agent as a badge and ignores the picker. Section headers have their own
terminal button with section-wide scenarios and the same target picker. All
scenarios are editable in Settings: name, scope (row or section), bound
sections, prompt, preferred agent, order, and an enabled toggle. *Just the link*
cannot be removed and must contain `{url}`.

Choosing the **DSH** target renders the same scenario prompt on the host and
opens it as a new DSH session draft through the `uiWorkspace.startSession` client
service; when the blank session already has a draft, the prompt is appended to
it. Nothing is submitted until you press Enter.

A section scenario takes the visible rows of every section it is bound to
(respecting the active section/source filter and search, and leaving out
snoozed items), builds one prompt with
the list, and launches **one** agent; the menu shows the count — "Review
everything awaiting me (12)". The prompt asks the agent to delegate each item to
a separate sub-agent where that makes sense. When every item is from one
repository the agent opens in that clone; otherwise it opens in the workspace.

Prompt templates use single-brace placeholders. Row scenarios: `{url}`, `{repo}`,
`{owner}`, `{name}`, `{number}`, `{title}`, `{branch}`, `{kind}`, `{ref}`,
`{author}`, `{reason}`. Section scenarios: `{links}` (the generated list),
`{count}`, `{section}`, `{date}`. Unknown `{…}` tokens stay as text. A section
prompt without `{links}` gets the generated list appended at the end; a row
prompt without `{url}` (and without `{links}`) gets the one-item list appended.
The list itself is written in English (`reason: new commits since my review`) so
it matches the built-in English prompts.

The prompt is rendered on the host from the snapshot; templates are capped at
4 000 characters and the rendered prompt at 16 000. When a section list does not
fit, the tail is dropped, the prompt says `Items: first N of M`, and the panel
warns in a toast.

The launch mechanics:

1. The plugin resolves the clone of the row's repository: manual
   `owner/repo = /path` overrides win (the repository name is matched
   case-insensitively), then configured clone directories; without configured
   directories it searches the typical folders that exist (`~/Projects`,
   `~/Developer`, `~/Documents/GitHub`, …) together with project roots detected
   in your home. For a section launch spanning several repositories it opens
   the current **workspace** instead. When a single-repository clone is
   missing, Terminal opens in the workspace and the prompt contains the links.
   It never runs `git fetch` or changes the working tree. Clone folders can be added with the native system folder
   picker; for manual paths, pick a clone folder and the plugin derives its
   `owner/repo` (from `upstream`, then `origin`, then the first other GitHub
   remote). Picker results preserve edits made while the dialog is open.
   Each nonempty manual mapping line needs `owner/repo = /absolute/path`;
   missing separators, repositories, or paths block saving with a line-specific
   error, retaining the text for correction.
2. It renders the scenario prompt for the row or for the visible section list.
3. **Claude Code** is launched with its native draft flag:
   `claude --prefill '<prompt>'`. The TUI opens with the prompt already in the
   composer and nothing submitted; review it and press Enter when ready.
4. Other agents do not expose a reliable draft mode, so they open **bare** and
   the prompt is copied to the system clipboard (`pbcopy`, `clip.exe`, or a
   Linux clipboard tool). Paste it, edit it, and send it yourself; a hint is
   printed above the agent.

Terminal platform support:

Launches group into one shared **Triage Desk** terminal window and open as tabs
where the terminal supports them. Re-launching the *same* agent on the *same*
item focuses its existing tab instead of opening a duplicate where the terminal
allows it (iTerm2 on macOS; `wmctrl` or `xdotool` on Linux); Windows Terminal
opens another tab in the shared window, and Terminal.app opens a new window.
This focus-or-reuse is best-effort and falls back to a fresh tab or window when
it is unavailable.

- **macOS** — **iTerm2** when it is installed: each launch opens a new tab in the
  current iTerm window (`create tab with default profile command …`), and
  re-launching focuses the matching tab. Without iTerm2 the fallback is a new
  **Terminal.app** window per launch — Terminal's AppleScript interface cannot
  create a tab (`do script … in window` writes into the current tab, which would
  corrupt a running agent's input), so it has no shared window and no focus-reuse.
- **Windows** — Windows Terminal (`wt.exe`) opens each launch as a new tab in the
  shared window (`wt -w 0 new-tab`) when it is on PATH; when the tab cannot be
  opened, a new Windows Terminal window (`wt -w -1 new-tab`) is tried. Without
  Windows Terminal, PowerShell opens a new console window (`cmd.exe /c start`).
  Windows Terminal multiplexes tabs into one host window, so a re-launch opens
  another tab in that window; per-tab focus by title is not available. Scripts
  are PowerShell 5.1 `.ps1` files, the clipboard uses `clip.exe`.
- **Linux** — `$TERMINAL` when it is an absolute path, otherwise the first found
  of `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `alacritty`,
  `x-terminal-emulator`, `xterm`. The first three open a tab when their server
  is running; the rest open a window. Focus-or-reuse uses `wmctrl -a` (or
  `xdotool` as a fallback) to raise the matching window by title when either is
  installed; both are X11 tools, so focus-reuse may be unavailable on a pure
  Wayland session, and neither is required. Clipboard uses `wl-copy`, `xclip`,
  or `xsel`. An open terminal survives a plugin reload and is closed when DSH
  quits.

Settings also has a **Find agents** button: it scans the login environment for
known CLIs — Claude Code, Codex, opencode, Gemini CLI, Cursor Agent, Antigravity,
pi, Aider, Amp, Droid, Goose, and Crush — and adds the ones that are installed
without touching the agents you already configured. Edits, additions, and removals
made while the scan runs are preserved.

Built-in agents (edit or extend them in Settings; the form edits the name and
the launch command, while the internal agent id stays stable and is not shown):

| Agent id | Launch command | Prompt delivery |
|---|---|---|
| `claude` | `claude {prompt}` | native `--prefill` (input box, unsent) |
| `codex` | `codex {prompt}` | clipboard |
| `opencode` | `opencode --prompt {prompt}` | clipboard |
| `gemini` | `gemini {prompt}` | clipboard |
| `cursor-agent` | `cursor-agent {prompt}` | clipboard |
| `agy` | `agy {prompt}` | clipboard |
| `pi` | `pi {prompt}` | clipboard |

Detection is best-effort and asks the login environment once for all configured
commands, because the DSH app itself often starts with a minimal `PATH`:

- **macOS** — an interactive login zsh (`/bin/zsh -lic`, `whence -p`), so PATH
  setup in `~/.zshrc` (such as nvm) counts.
- **Linux** — the login shell from `$SHELL` when it is a POSIX-family shell,
  otherwise `/bin/sh`; bash is asked as an interactive login shell
  (`-lic`, `type -P`), so PATH setup in `~/.bashrc` (such as nvm) counts.
- **Windows** — PowerShell `Get-Command`, limited to applications and scripts.

Only absolute paths count. An alias whose value is one absolute executable
resolves to that executable; any other alias or a shell function is reported as
unavailable (the menu says *shell alias or function — use a path*), because the
launch shell does not have your aliases. Configured binaries that are not found
are shown as *not installed* and cannot be launched. On macOS and Linux a launch
runs the detected absolute path and adds its directory to `PATH` when it is
missing, so `#!/usr/bin/env node` shims (nvm) find their runtime. The
`triage_desk` agent tool exposes the same action, so "open Codex on PR 288" in
chat opens the same window. Tool-driven launches use the same draft/clipboard
behavior: the agent may start, but nothing is submitted.

Agent commands must contain `{prompt}` exactly once, unquoted and unescaped,
after the executable word: either as its own argument (`codex {prompt}`) or
directly after a `--flag=` (`aider --message={prompt}`). Quoted or otherwise
embedded placeholders, command substitutions (`$( )`, `${ }`, backticks),
comments, and shell operators (`; & | < > ( )`) are rejected; use a wrapper
executable for complex shell setup. Quoted executable paths and static
arguments are supported, as are POSIX environment assignments before the
executable (including quoted values with spaces). Clipboard launches preserve
the remaining command's quoting and argument spacing; Windows draft/clipboard
launches also keep quoted paths and arguments as single words. Prompt text is
quoted as data, but the configured command itself is trusted code, not a sandbox.

Saved agents that break this rule (for example, written by hand into the
profile) are not dropped silently: the valid agents stay usable, the invalid
ones appear in Settings as editable rows marked invalid (fix the command or
remove the row before saving), and a scenario pinned to such an agent fails
with an explanation until it is fixed. When no saved agent is valid, the built-in
presets are used and the warning lists the rejected ones.

Security note: native `--prefill` passes the prompt as an agent argument, so it
is visible in the process list. The default scenario's prompt is just the GitHub
URL; longer scenario prompts and section lists are visible there as well. Other
agents receive the prompt only through the clipboard.

## Configuration

The settings form writes the plugin row's `config` into the active DSH profile.
The same fields can be set manually in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `orgs` | `[]` | Organizations to scan, at most 10; empty auto-detects memberships, of which the first 10 are scanned (an `orgs-truncated` warning names the cap) |
| `includePersonal` | `true` | Include the account's personal repositories as a source |
| `refreshSeconds` | `1200` | Panel auto-refresh interval, 15–3600 s |
| `ttlMs` | `max(refreshSeconds, 600)` s, capped at 1 h | Host snapshot cache lifetime |
| `requireGreenChecks` | `true` | List under "Ready to merge" only with green checks or no checks (pending/red are excluded) |
| `includeBotReviews` | `false` | Count reviews from bot accounts as yours on the PRs your searches return |
| `agents` | built-in presets | Agent list (up to 12): `{ id, label, command }`; `command` contains exactly one unquoted `{prompt}` after the executable, as its own word or after `--flag=` (see [Terminal launcher](#terminal-launcher)) |
| `defaultAgent` | `claude` | Agent id used when the menu is not opened explicitly |
| `cloneDirs` | `[]` | Optional base directories for clone discovery, up to 8 (hidden under *Advanced*); empty searches the typical dirs that exist (`~/Projects`, `~/Developer`, …) plus project roots detected in your home |
| `repoPaths` | `{}` | Optional `owner/repo` → absolute clone path exceptions, up to 50, matched case-insensitively (hidden under *Advanced*) |
| `scenarios` | built-in set | Named launch scenarios: `{ id, label?, scope: 'item' \| 'section', sections, prompt, agent: 'default' \| <agent id>, enabled }`; array order is menu order; the `link` scenario must exist, stay enabled, and contain `{url}` |
| `defaultScenario` | `link` | Row scenario placed first in the menu |
| `ghCommand` | `gh` | Path to the GitHub CLI |
| `timeoutMs` | `30000` | Timeout of one `gh` invocation |
| `meLogins` | `[]` | Extra self logins: decide ownership, direct review requests, your activity, and recent branch authors on the items the signed-in account's searches find. PRs that involve only an alias are not found; aliases add no sources or team memberships |
| `teams` | `[]` | Reviewer teams, if `gh` cannot read team membership |

The auto-refresh select also accepts a custom value: choose **Custom…** and
enter minutes (1–60). The config field `refreshSeconds` is in seconds.

## How it works

- The **host half** (`index.js` + `github.js`) collects a snapshot through the
  signed-in `gh` CLI. Sources are the personal account (`user:<login>`) and each
  organization (`org:<login>`). For every source one GraphQL request reads your
  team memberships and runs three searches for open pull requests in
  non-archived repositories, most recently updated first —
  `review-requested:<you>` (which also matches requests to your teams),
  `reviewed-by:<you>`, and `author:<you>` — and a second query searches for
  issues assigned to you, new unassigned issues, and mentions. Each PR search reads 25 results per
  page and follows up to 4 pages (100 PRs); a PR found by several searches is
  listed once. Branch CI comes from a separate repository scan without pull
  requests: 100 repositories per page, newest pushed first, up to 3 pages (300
  repositories) per source, reading each repository's default-branch checks and
  up to 100 branch heads. Sources take turns: every source gets its first
  request before any source reads a second page, so one large organization
  cannot use up the refresh. Results are cached (single-flight, TTL above) and
  served to the panel over `GET /triage-desk/snapshot` on the Host's own web
  server; the route is fenced with the browser-trust check.
- The searches run for the signed-in account only. `meLogins` aliases decide
  ownership, review requests, and activity on the PRs those searches return,
  and `includeBotReviews` applies to the same PRs; a PR that involves only an
  alias is not found.
- The **client half** (`client.js`) is a plain-JavaScript DSH client bundle: it
  registers the sidebar panel and the page, polls the snapshot, and renders it
  with the host theme tokens. Returning to a hidden browser tab immediately
  rechecks the snapshot through the host cache; changing the interval restarts
  the timer; relative times ("updated 3 min ago") advance every minute. After a
  failed load the panel retries after 15 s, 60 s, and 5 min (each capped by the
  refresh interval), then waits for the regular poll. A stale snapshot's banner
  shows the current failure. Delayed recovery is cancelled when the last view
  unmounts or the plugin is disposed, including when an older response arrives
  afterward. No build step, no external network calls.
- Settings are saved through DSH's config editor into the profile patch; a
  change restarts the plugin and the panel refreshes itself. The host answers
  only after the profile write and the plugin restart complete, and only then
  does the panel show **Saved**. A failed write keeps the form open with the
  error and the edits available for retry. Settings reads started before a
  confirmed save cannot overwrite its values or status. Leaving Settings with
  unsaved edits (Back, Cancel, or the gear) asks whether to discard them or keep
  editing.
- Team review requests are matched against the teams you actually belong to
  (`teams(userLogins:)`), not against every team in the organization. When that
  membership cannot be read (for example, without the `read:org` scope or for
  nested teams), a PR that GitHub's `review-requested:` search returned is
  attributed to the first team among its requested reviewers.
- Launch scenarios are normalized and their prompts rendered in `launcher.js`
  (pure helpers: tokens, the item list block, trimming); `POST /triage-desk/launch`
  validates the scenario and URLs, resolves the clone and agent on the host, and
  only then asks the OS to open Terminal. `GET /triage-desk/clones` powers the
  "Check clones" button in Settings.
- Transient network failures are retried once. A source whose PR search fails
  is reported as unavailable and the snapshot is partial; a failed issue search
  or branch scan keeps the source's pull requests and only makes the snapshot
  partial. When a refresh cannot scan any source
  (network down, rate limit, plugin reload), the panel and the agent tool keep
  the previous snapshot, marked stale with the reason, instead of showing an
  empty inbox; without a previous snapshot the error is reported explicitly. A
  permission denial (HTTP 403) on one source does not stop the other sources;
  an explicit rate-limit error or HTTP 429 stops further requests. A cancelled
  agent tool call stops waiting but does not cancel the shared refresh.

## Limitations

- Coverage is bounded per refresh: at most 10 organizations (`orgs-truncated`
  warning), 100 open PRs per search and source (`prs-truncated`), and 300
  repositories per source for branch CI (`repos-truncated`). The limits keep the
  most recently updated PRs and the most recently pushed repositories, which is
  not a guarantee that older ones have no pending work.
- A refresh has no fixed point budget. It stops starting queries only when
  GitHub reports a rate limit or 100 or fewer points remaining; fetched results
  are kept and a `scan-budget` warning marks the snapshot partial. By GitHub's
  documented cost formula (an estimate, not a measurement) a source costs about
  21 points in a typical refresh and about 70 when every search and repository
  page is followed; the returned costs are recorded in the snapshot metadata.

- Only GitHub is supported. The data layer is isolated in `github.js` and the snapshot
  contract is provider-neutral, so a GitLab (or other) provider can be added
  without touching the UI.
- Re-review uses `viewerLatestReview` for your own last review, so the review
  window cannot hide it. Other PR history is read in bounded windows: the last
  50 reviews, the last 30 comments, and the last 10 review threads with their
  last 5 comments each. When GitHub reports more, the snapshot carries a
  `truncated-history` warning instead of silently dropping them. New commits are
  always detected: the head commit id is compared with the commit your latest
  review was attached to.
- The terminal launcher supports macOS (iTerm2 tabs, else Terminal.app windows),
  Windows (Windows Terminal or PowerShell), and Linux (the common terminal
  emulators). Launches share one Triage Desk window; focus-reuse works with
  iTerm2 on macOS and with `wmctrl` or `xdotool` on Linux (X11), while Windows
  opens another tab in the shared window. Orca-managed terminals and an embedded
  terminal inside DSH are natural next steps.
- macOS without iTerm2 opens a new Terminal.app window per launch: Terminal's
  scripting interface has no API for creating tabs, so install iTerm2 to get
  shared-window tabs and focus-reuse. Windows tabs need Windows Terminal ≥ 1.5.
- Windows: PowerShell scripts are written as UTF-8 with a BOM and draft prompt
  files are read explicitly as UTF-8; a `;` in the tab title or script path is
  escaped as `\;` for Windows Terminal; double quotes in the prompt are escaped
  for PowerShell 5.1's native argument passing. A prompt argument ending in a
  backslash and agents installed as `.cmd` shims have not been verified on a
  real Windows host.
- Linux launches observe immediate startup errors for 500 ms and then report
  success; the emulator keeps running without a lifetime timeout. Failures after
  that observation window are not reported.
- Clone discovery scans the search directories three levels deep, with an
  independent 400-directory budget per root, and skips hidden and heavy
  directories. Symlinked directories are followed, each real directory once.
  All git remotes that point to GitHub count, so a fork with `origin` and
  `upstream` serves either repository. HTTPS, `ssh://`, and scp-style remotes
  (with or without `git@`) are recognized, as are SSH host aliases from
  `~/.ssh/config` whose `HostName` is `github.com` or `ssh.github.com` (literal
  `Host` names only; wildcard blocks, `Match`, and `Include` are not
  evaluated). Worktrees and submodules are found when the git config can be
  read; otherwise add a `repoPaths` override.
- The launch action never clones, fetches, checks out, or changes git state. When
  no local clone is found it opens the agent in the current workspace; clone
  search settings live under *Advanced* in Settings.
- Light/dark themes both use the host theme tokens.
- The DSH target opens its session in the current workspace, so it does not
  change directory to the repository clone; the prompt contains the links
  and the scenario text.

## Development

```
index.js     host plugin entry: wires host/ modules, routes, the agent tool
host/        host modules: snapshot cache and store, config, processes and terminals, agents, clones, launch
github.js    GitHub data layer: GraphQL, gh runner, snapshot normalization
launcher.js  launcher entry: re-exports launcher/ (agent commands, presets, scenarios and prompts, clone discovery, scripts, terminal plans)
launcher/    launcher modules, pure helpers and platform scripts
client.js    client bundle: sidebar panel + page + settings form + scenario menus
locale/      Plugin Manager display metadata (en, zh)
icon.svg     plugin icon
docs/        architecture map, shared contracts, and the local dev workflow ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DEV_LOCAL.md](docs/DEV_LOCAL.md))
dev/         smoke scripts used while developing (not shipped in npm)
```

Development setup and the default gate:

```sh
npm install           # installs ESLint + React for the render smoke and sets .githooks
npm run check         # lint + docs links + client/render/launcher/routes/cache/snapshot
npm test              # alias for npm run check
```

The pre-commit hook runs `npm run check`; it is enabled by the `prepare` script
(`git config core.hooksPath .githooks`). CI (`.github/workflows/check.yml`) runs
the same command with `npm ci`. Pull requests from organization members also get
an automated review from the DeepSeek review bot
(`.github/workflows/deepseek-review.yml`); it reads the diff through the GitHub
API and never checks out or runs pull request code.

- `npm run smoke:client` — registers the client bundle against a fake module
  loader, checks the slot registrations, validates EN/ZH dictionary parity
  (key sets, placeholders, literal `t()` keys), and tests polling, retries, and
  visibility handling with fake timers.
- `npm run smoke:render` — renders the real `Page` and the settings screen with
  a fixture snapshot (catches components that read missing props/state and
  capability-gated controls that should be hidden), and drives settings flows,
  the minute tick, and launch-menu interactions through a deterministic hook
  runner (not a browser DOM).
- `npm run check:docs` — verifies relative links/images in both READMEs (English
  and Chinese) resolve.
- `npm run smoke:launcher` — checks scenario prompts and tokens, clone
  discovery/matching, the native draft launcher (`--prefill`) and the clipboard
  fallback script.
- `npm run smoke:routes` — exercises the host routes, fencing, clone scanning,
  native-picker routes, launch success/failure paths, and the launch tool action
  with a fake subprocess layer (never opens Terminal).
- `npm run smoke:cache` — checks snapshot-cache behaviour: success is cached,
  failures are retried, a forced refresh during an in-flight build is queued, and
  the TTL can be supplied dynamically.
- `npm run smoke:snapshot` — runs the real snapshot builder and host cache
  against a fake `gh` that answers by GraphQL operation name (`ViewerSources`,
  `PullSearch`, `IssueSearch`, `PullSearchPage`, `BranchScan`) and rejects queries with
  unused or undeclared variables: section classification, search pagination and
  truncation, branch CI, quota stops, partial and failed sources, the previous
  snapshot kept as stale, and a cancelled tool call not cancelling the build.
- `npm run smoke:host` — **live/opt-in only**: runs the host half against a fake
  Cordis context and the real `gh` CLI (requires `gh auth login`); it spends
  GitHub quota, so it is not part of `npm run check` or CI.

### Releasing (maintainers)

```sh
npm run check        # full gate; prepublishOnly runs it again on publish
npm pack --dry-run   # inspect what goes into the tarball
npm publish          # unscoped public package
```

Bump `version` in `package.json` (the project starts at `0.1.0`) and add a
matching section to `CHANGELOG.md`. The package ships the host and client halves,
launch presets, locale metadata, both READMEs (English and Chinese), the
changelog, the license, `docs/ARCHITECTURE.md`, and `docs/DEV_LOCAL.md`;
development smokes and the contributor docs (`AGENTS.md`, `CODING_STANDARDS.md`)
stay out.

The GitHub release (`v0.1.0`, with the notes from the changelog) should exist
before the npm package is announced, so the `repository`, `homepage`, and `bugs`
links resolve. To list the plugin in the community market, open a pull request
against
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
that adds one `data/plugins/<owner>__<repo>.yml` entry (category `git`); the
curated list feeds [dsh-market](https://github.com/dsh-market/dsh-market) and the
DSH Discover index. The npm mapping is picked up automatically from the
published `repository` field, and `npm pack --dry-run` is a good final check that
the tarball contains the two READMEs, both locale files, and both docs.

There is intentionally no `export const Config`: the row config is validated by
the settings endpoint and read with defaults in code, so the bundle needs no
`@deepseek-ai/*` dependency (a linked local bundle cannot resolve them).

## License

[MIT](LICENSE)
