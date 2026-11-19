# Triage Desk reference

The full behavior of Triage Desk. The [README](../README.md) is the short
overview; [ARCHITECTURE.md](ARCHITECTURE.md) maps files and contracts.

## Contents

- [Inbox](#inbox)
- [Snooze](#snooze)
- [Launch scenarios](#launch-scenarios)
- [Terminal launcher](#terminal-launcher)
  - [Choosing a terminal](#choosing-a-terminal)
  - [Prompt delivery](#prompt-delivery)
  - [Launch steps](#launch-steps)
  - [Agents](#agents)
- [Clone discovery](#clone-discovery)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Development](#development)
- [Releasing (maintainers)](#releasing-maintainers)

## Inbox

Triage Desk reads pull requests, issues, reviews, and CI through the signed-in
GitHub CLI; other code hosts are not supported. If GitHub is not connected, the
error notice has a **Sign in to GitHub** action; Settings also shows whether
`gh` is installed and which account is connected, and its **Sign in to GitHub**
button opens an interactive `gh auth login` in a terminal.

Sections:

- **Waiting for your review**: open PRs where your review is requested directly
  or through a team, and you have not reviewed the current head yet.
- **Re-review needed**: PRs you already reviewed whose head commit is no longer
  the one you reviewed (new commits, a rebase, or a force-push; matched by commit
  id, not by commit date), PRs where the author clicked **Re-request review** for
  you, or PRs where the author replied **to you** after your last action (a
  threaded reply to your review comment or an explicit @-mention). An author
  reply alone is secondary: it stays in the same section, muted and at the
  bottom, with the exact reason in the row tooltip. Other reviewers' activity
  alone does not ask you for another pass.
- **Ready to merge**: your PRs that are approved, mergeable, and (by default)
  green. PRs GitHub marks `BLOCKED` are excluded even when approval and checks
  pass.
- **Needs your action**: your PRs with requested changes, conflicts, or new
  reviewer comments (including inline review threads) that expect fixes, plus
  issues assigned to you and issues/PRs where you were mentioned and have not
  replied, including ones you authored. A newer approval is not treated as
  "needs a reply": it moves the PR toward *Ready to merge* instead.
- **CI is failing**: red checks on your PRs and on branches, in personal and
  organization repositories: a red default branch of a repository you administer
  or maintain, and any red branch (the default one included) whose latest commit
  you (or a configured self alias) authored within the last week.
- **New in your repositories**: **unassigned** issues opened in the last 30 days
  in repositories you maintain, styled quieter; they do not inflate the attention
  counter. Issues with an assignee are either your action (assigned to you, under
  *Needs your action*) or that person's work, so they never appear here. The
  30-day window is fixed; snooze the issues you do not want to see.

Other panel features:

- **Copy a link**: each row has one copy-link action; the toolbar and section
  headers do not duplicate it.
- **Counters**: the sidebar badge counts each item once (a PR in both *Needs your
  action* and *CI is failing* is one item), leaves out review requests that are
  optional because someone else's approval already satisfies the PR, and leaves
  out snoozed items and new unassigned issues. Section chips (and *Snoozed*)
  count the rows the list shows under the current source filter and search; the
  page total is the badge for the selected source.
- **Sources**: GitHub personal repositories and up to 10 organizations the
  account belongs to (or an explicit list of up to 10). Each row carries its
  source, and a source filter narrows the list (and its counts) when more than
  one source is connected.
- **Languages**: English and Chinese. There is no language setting in the
  plugin; the panel follows the DSH interface language, and every interface
  language other than Chinese shows English.
- **Agent tool**: `triage_desk` returns the same snapshot to a DSH agent, so
  "what needs my attention?" is answered from one source of truth. When you ask
  explicitly, it also opens a terminal for a URL (for example "open Codex on PR
  288"), with the same prompt delivery as the panel: the agent may start, but
  nothing is submitted.
- **Settings in the panel**: organizations, personal repositories, auto-refresh
  interval, green-CI merge rule, bot-review handling, terminal, prompt delivery,
  agents, launch scenarios, and clone search. Terminal settings are grouped under
  *Terminal and agents*; clone search under *Advanced: clone search*. The
  auto-refresh select accepts **Custom…** in minutes (1–60).
- Light and dark themes both use the host theme tokens.

## Snooze

- The clock button on a row opens a menu: *Until new activity* (the default),
  *Until tomorrow* (09:00 local time), or *Until next week* (Monday 09:00). The
  item leaves every section and the badge. Any new activity on GitHub (a newer
  `updatedAt`, or a new commit for a branch) brings it back early, also for a
  timed snooze; a timed snooze ends on time without a refresh.
- A toast confirms the snooze with *Undo* for about 6 seconds.
- The *Snoozed (n)* chip after the section chips shows the snoozed items, dimmed,
  each with its return time and *Unsnooze*; it disappears when nothing is
  snoozed.
- **Bulk snooze**: the clock button in a section header snoozes every row the
  section shows (after the source filter and search) through the same menu; in
  the Snoozed view it becomes *Unsnooze all (n)*.
- **Selection**: *Select* next to the search field gives every row a checkbox
  before its icon. A click anywhere on a row selects it instead of opening the
  link (Space on a focused checkbox works too; Shift+click selects a range within
  a section), each section header gets a select-all checkbox, and the row buttons
  step aside. A bottom bar offers *Snooze* (or *Unsnooze* in the Snoozed view),
  *Select all* / *Deselect all*, and *Done*. A PR listed in two sections is one
  selected item. A filter, source, or search change clears the selection but
  keeps the mode; Done, Escape, or a finished bulk action leave it. One toast
  with one *Undo* covers the whole bulk action.
- Snoozes are kept in this browser's local storage (`triage-desk:snoozed:v2`)
  and are not synced between devices; entries for items that left the inbox are
  pruned after a complete refresh.

## Launch scenarios

Every row with a GitHub link has a terminal button. It opens a compact menu: a
**target picker** first (**DSH — this app** plus the installed terminal agents),
a line saying where the selected agent opens and how it gets the prompt, then the
scenarios that apply to the row, the default scenario on top.

A scenario is a named prompt template. The built-in row scenarios are *Just the
link*, *Review this PR* (only on rows waiting for your review), *Re-review after
changes* (only on re-review rows), *Fix this PR*, *Reply in the thread*, and
*Triage this issue*. Section headers have their own terminal button with
section-wide scenarios (*Review everything awaiting me*, *Fix my PRs*, *Triage
new issues*, *Answer mentions*) and the same target picker. A scenario can pin
its own agent: it then shows that agent as a badge and ignores the picker.

All scenarios are editable in Settings: name, scope (row or section), bound
sections, prompt, preferred agent, order, and an enabled toggle. *Just the link*
cannot be removed and must contain `{url}`.

**DSH target.** The host renders the same scenario prompt and opens it as a new
DSH session draft through the `uiWorkspace.startSession` client service; when the
blank session already has a draft, the prompt is appended to it. No terminal is
opened, and nothing is submitted until you press Enter. The session opens in the
current workspace, not in the repository clone; the prompt contains the links
and the scenario text.

**Section scenarios** take the visible rows of every section they are bound to
(respecting the active section/source filter and search, and leaving out snoozed
items), build one prompt with the list, and launch **one** agent; the menu shows
the count, for example "Review everything awaiting me (12)". The prompt asks the
agent to delegate each item to a separate sub-agent where that makes sense. When
every item is from one repository the agent opens in that clone; otherwise it
opens in the workspace.

**Placeholders** use single braces. Row scenarios: `{url}`, `{repo}`, `{owner}`,
`{name}`, `{number}`, `{title}`, `{branch}`, `{kind}`, `{ref}`, `{author}`,
`{reason}`. Section scenarios: `{links}` (the generated list), `{count}`,
`{section}`, `{date}`. Unknown `{…}` tokens stay as text. A section prompt without
`{links}` gets the generated list appended at the end; a row prompt without
`{url}` (and without `{links}`) gets the one-item list appended. The list itself
is written in English (`reason: new commits since my review`) so it matches the
built-in English prompts.

**Limits.** Prompts are rendered on the host from the snapshot. Templates are
capped at 4 000 characters and the rendered prompt at 16 000. When a section
list does not fit, the tail is dropped, the prompt says `Items: first N of M`,
and the panel warns in a toast.

## Terminal launcher

A terminal launch opens the agent in the repository's local clone (see [Clone
discovery](#clone-discovery)) with the prompt prepared but **not sent**. The
terminal stays open with a shell after the agent exits, survives a plugin
reload, and is closed when DSH quits. The **Sign in to GitHub** button uses the
same terminal.

### Choosing a terminal

Settings → *Terminal and agents* → **Open agents in** offers *Automatic* or one
of this platform's terminals; terminals that are not installed are shown
disabled. The config key is `terminal`: `auto` (default) or a terminal id. A
saved terminal that is not installed falls back to Automatic at launch, and the
launch toast says so.

| Platform | Terminal | Id | Opens |
|---|---|---|---|
| macOS | Terminal | `terminal` | a new window per launch |
| macOS | iTerm2 | `iterm` | a tab in the current window |
| macOS | Ghostty | `ghostty` | a tab in the current window |
| Linux | GNOME Terminal | `gnome-terminal` | a tab |
| Linux | Konsole | `konsole` | a tab |
| Linux | Xfce Terminal | `xfce4-terminal` | a tab |
| Linux | Ghostty | `ghostty` | a window |
| Linux | kitty | `kitty` | a window |
| Linux | Alacritty | `alacritty` | a window |
| Linux | xterm | `xterm` | a window |
| Windows | Windows Terminal | `windows-terminal` | a tab in the shared window |
| Windows | PowerShell window | `console` | a new console window |

*Automatic* resolves to:

- **macOS**: iTerm2 when installed, otherwise Terminal.
- **Linux**: `$TERMINAL` when it is an absolute path, otherwise the first
  installed of `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`,
  `alacritty`, `x-terminal-emulator`, `xterm`.
- **Windows**: Windows Terminal when installed, otherwise a PowerShell window.

Re-launching the *same* agent on the *same* item switches to its existing tab
instead of opening a duplicate where the terminal allows it. This
focus-or-reuse is best-effort and falls back to a fresh tab or window.

- **macOS**: iTerm2 opens each launch as a new tab in the current window
  (`create tab with default profile command …`) and re-launching selects the
  matching tab. Ghostty (1.4 or later, through its AppleScript dictionary) opens
  a tab in the front window, or a new window when none is open, and re-launching
  selects the tab whose title matches. Terminal opens a new window per launch:
  its AppleScript interface cannot create a tab (`do script … in window` writes
  into the current tab, which would corrupt a running agent's input), so it has
  no shared window and no focus-reuse.
- **Linux**: GNOME Terminal, Konsole, and Xfce Terminal open a tab when their
  server is running; the others open a window. Focus-or-reuse uses `wmctrl -a`
  (or `xdotool` as a fallback) to raise the matching window by title when either
  is installed. Both are X11 tools, so focus-reuse may be unavailable on a pure
  Wayland session; neither is required.
- **Windows**: Windows Terminal (`wt.exe`) opens each launch as a new tab in the
  shared window (`wt -w 0 new-tab`); when the tab cannot be opened, a new Windows
  Terminal window (`wt -w -1 new-tab`) is tried. The PowerShell choice opens a
  new console window (`cmd.exe /c start`). Windows Terminal multiplexes tabs into
  one host window, so a re-launch opens another tab there; per-tab focus by title
  is not available. Launch scripts are PowerShell 5.1 `.ps1` files.

### Prompt delivery

**Claude Code** always opens with its native draft flag,
`claude --prefill '<prompt>'`: the TUI starts with the prompt in its composer and
nothing submitted.

For every other agent, Settings → **Prompt delivery** (config key
`promptDelivery`) chooses how the prompt arrives:

- **Type into the agent** (`paste`, the default and recommended): the agent runs
  through a small paste wrapper in a pseudo-terminal. The wrapper:
  1. waits until the agent's input box is ready: the agent turns on bracketed
     paste and its screen settles (quiet for 0.7 s, or 2.5 s after bracketed
     paste turned on for agents that keep redrawing);
  2. while a folder-trust dialog is on screen, waits until you press Enter, then
     waits for readiness again;
  3. pastes the prompt into the input box as one bracketed paste, without
     pressing Enter, so you review it and send it yourself. Control characters
     other than newline and tab are removed from the prompt first, so it cannot
     end the paste early or send keys;
  4. passes everything else through unchanged, follows the real window size, and
     exits with the agent's exit status. When the agent is not ready within
     2 minutes, nothing is pasted.

  The prompt is also copied to the clipboard as a fallback. Verified with Claude
  Code, Codex, opencode, and Antigravity (`agy`); the wrapper works with any
  agent whose TUI supports bracketed paste.
- **Copy to clipboard** (`clipboard`): the agent opens empty with the prompt on
  the clipboard and a hint printed above it. Paste it with ⌘V on macOS,
  Ctrl+Shift+V in Linux terminals, or Ctrl+V on Windows; the toast and Settings
  show the keys for your platform. The clipboard uses `pbcopy` on macOS,
  `clip.exe` on Windows, and `wl-copy`, `xclip`, or `xsel` on Linux.

Requirements for **Type into the agent**:

- **macOS**: Python 3, from the Command Line Tools (`xcode-select --install`);
  Homebrew Python also works.
- **Linux**: Python 3 with the standard `pty` module.
- **Windows**: Windows 10 version 1809 or later (ConPTY). The wrapper is
  compiled by PowerShell 5.1 at launch.

When the requirement is missing, Settings shows why and launches use the
clipboard; the launch toast tells you how to fix it.

Each launch menu shows a line for the selected agent, such as *Opens in Ghostty ·
prompt typed into the input box, unsent*, *Opens in Terminal · prompt in the input
box, unsent* (Claude Code), or *Opens in iTerm2 · prompt copied to the clipboard
(⌘V)*. The launch toast names the agent and the terminal, for example *Codex
opened in Ghostty (/path): the prompt will appear in its input box, not sent —
review it and press Enter*.

**Security note.** Native `--prefill` passes the prompt as an agent argument, so
it is visible in the process list. The default scenario's prompt is just the
GitHub URL; longer scenario prompts and section lists are visible there as well.
The paste wrapper reads the prompt from a temporary file that it deletes once
read; the clipboard receives it in every mode.

### Launch steps

1. The plugin resolves the clone of the row's repository (see [Clone
   discovery](#clone-discovery)). A section launch spanning several repositories
   opens the current **workspace**; when a single-repository clone is missing,
   the agent opens in the workspace and the prompt contains the links. It never
   clones, fetches, checks out, or changes git state.
2. It renders the scenario prompt for the row or for the visible section list.
3. It picks the prompt delivery: native draft for Claude Code, otherwise the
   paste wrapper or the clipboard (see [Prompt delivery](#prompt-delivery)).
4. It writes a launch script and opens it in the chosen terminal (see [Choosing
   a terminal](#choosing-a-terminal)), or focuses the existing tab for the same
   agent and item.

### Agents

Built-in agents (edit or extend them in Settings; the form edits the name and the
launch command, while the internal agent id stays stable and is not shown):

| Agent id | Launch command | Prompt delivery |
|---|---|---|
| `claude` | `claude {prompt}` | native `--prefill` (input box, unsent) |
| `codex` | `codex {prompt}` | Prompt delivery setting |
| `opencode` | `opencode --prompt {prompt}` | Prompt delivery setting |
| `gemini` | `gemini {prompt}` | Prompt delivery setting |
| `cursor-agent` | `cursor-agent {prompt}` | Prompt delivery setting |
| `agy` | `agy {prompt}` | Prompt delivery setting |
| `pi` | `pi {prompt}` | Prompt delivery setting |

**Find agents** in Settings scans the login environment for known CLIs (Claude
Code, Codex, opencode, Gemini CLI, Cursor Agent, Antigravity, pi, Aider, Amp,
Droid, Goose, and Crush) and adds the installed ones without touching the agents
you already configured. Edits, additions, and removals made while the scan runs
are preserved.

**Detection** is best-effort and asks the login environment once for all
configured commands, because the DSH app often starts with a minimal `PATH`:

- **macOS**: an interactive login zsh (`/bin/zsh -lic`, `whence -p`), so PATH
  setup in `~/.zshrc` (such as nvm) counts.
- **Linux**: the login shell from `$SHELL` when it is a POSIX-family shell,
  otherwise `/bin/sh`; bash is asked as an interactive login shell (`-lic`,
  `type -P`), so PATH setup in `~/.bashrc` (such as nvm) counts.
- **Windows**: PowerShell `Get-Command`, limited to applications and scripts.

Only absolute paths count. An alias whose value is one absolute executable
resolves to that executable; any other alias or a shell function is reported as
unavailable (the menu says *shell alias or function — use a path*), because the
launch shell does not have your aliases. Configured binaries that are not found
are shown as *not installed* and cannot be launched. On macOS and Linux a launch
runs the detected absolute path and adds its directory to `PATH` when it is
missing, so `#!/usr/bin/env node` shims (nvm) find their runtime.

**Command rules.** An agent command must contain `{prompt}` exactly once,
unquoted and unescaped, after the executable word: either as its own argument
(`codex {prompt}`) or directly after a `--flag=` (`aider --message={prompt}`).
Quoted or otherwise embedded placeholders, command substitutions (`$( )`,
`${ }`, backticks), comments, and shell operators (`; & | < > ( )`) are rejected;
use a wrapper executable for complex shell setup. Quoted executable paths and
static arguments are supported, as are POSIX environment assignments before the
executable (including quoted values with spaces). Paste and clipboard launches
run the command without its `{prompt}` argument and preserve the remaining
quoting and argument spacing; on Windows, quoted paths and arguments stay single
words. Prompt text is quoted as data, but the configured command itself is
trusted code, not a sandbox.

**Invalid saved agents** (for example, written by hand into the profile) are not
dropped silently: the valid agents stay usable, the invalid ones appear in
Settings as editable rows marked invalid (fix the command or remove the row
before saving), and a scenario pinned to such an agent fails with an explanation
until it is fixed. When no saved agent is valid, the built-in presets are used
and the warning lists the rejected ones.

## Clone discovery

- Manual `owner/repo = /path` overrides (`repoPaths`) win; the repository name is
  matched case-insensitively. Then the configured clone directories
  (`cloneDirs`) are searched. Without configured directories the plugin
  searches the typical folders that exist (`~/Projects`, `~/Developer`,
  `~/Documents/GitHub`, …) together with project roots detected in your home.
- Clone folders can be added with the native system folder picker. For manual
  paths, pick a clone folder and the plugin derives its `owner/repo` (from
  `upstream`, then `origin`, then the first other GitHub remote). Picker results
  preserve edits made while the dialog is open.
- Each nonempty manual mapping line needs `owner/repo = /absolute/path`; missing
  separators, repositories, or paths block saving with a line-specific error,
  keeping the text for correction.
- **Check clones** in Settings shows what the search finds.
- The search goes three levels deep, with an independent 400-directory budget per
  root, and skips hidden and heavy directories. Symlinked directories are
  followed, each real directory once.
- All git remotes that point to GitHub count, so a fork with `origin` and
  `upstream` serves either repository. HTTPS, `ssh://`, and scp-style remotes
  (with or without `git@`) are recognized, as are SSH host aliases from
  `~/.ssh/config` whose `HostName` is `github.com` or `ssh.github.com` (literal
  `Host` names only; wildcard blocks, `Match`, and `Include` are not evaluated).
- Worktrees and submodules are found when their git config can be read;
  otherwise add a `repoPaths` override.

## Configuration

The settings form writes the plugin row's `config` into the active DSH profile.
The same fields can be set manually in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `orgs` | `[]` | Organizations to scan, at most 10; empty auto-detects memberships, of which the first 10 are scanned (an `orgs-truncated` warning names the cap) |
| `includePersonal` | `true` | Include the account's personal repositories as a source |
| `refreshSeconds` | `1200` | Panel auto-refresh interval, 15–3600 s (the form's **Custom…** option takes minutes, 1–60) |
| `ttlMs` | `max(refreshSeconds, 600)` s, capped at 1 h | Host snapshot cache lifetime |
| `requireGreenChecks` | `true` | List under "Ready to merge" only with green checks or no checks (pending/red are excluded) |
| `includeBotReviews` | `false` | Count reviews from bot accounts as yours on the PRs your searches return |
| `agents` | built-in presets | Agent list (up to 12): `{ id, label, command }`; `command` contains exactly one unquoted `{prompt}` after the executable, as its own word or after `--flag=` (see [Agents](#agents)) |
| `defaultAgent` | `claude` | Agent id used when the menu is not opened explicitly |
| `terminal` | `auto` | Terminal for launches: `auto` or one of `terminal`, `iterm`, `ghostty`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `alacritty`, `xterm`, `windows-terminal`, `console` (see [Choosing a terminal](#choosing-a-terminal)) |
| `promptDelivery` | `paste` | How agents without a native draft get the prompt: `paste` (typed into the input box, unsent) or `clipboard` (see [Prompt delivery](#prompt-delivery)) |
| `cloneDirs` | `[]` | Optional base directories for clone discovery, up to 8 (under *Advanced: clone search*); empty searches the typical dirs that exist (`~/Projects`, `~/Developer`, …) plus project roots detected in your home |
| `repoPaths` | `{}` | Optional `owner/repo` → absolute clone path exceptions, up to 50, matched case-insensitively (under *Advanced: clone search*) |
| `scenarios` | built-in set | Named launch scenarios: `{ id, label?, scope: 'item' \| 'section', sections, prompt, agent: 'default' \| <agent id>, enabled }`; array order is menu order; the `link` scenario must exist, stay enabled, and contain `{url}` |
| `defaultScenario` | `link` | Row scenario placed first in the menu |
| `ghCommand` | `gh` | Path to the GitHub CLI |
| `timeoutMs` | `30000` | Timeout of one `gh` invocation |
| `meLogins` | `[]` | Extra self logins: decide ownership, direct review requests, your activity, and recent branch authors on the items the signed-in account's searches find. PRs that involve only an alias are not found; aliases add no sources or team memberships |
| `teams` | `[]` | Reviewer teams, if `gh` cannot read team membership |

There is intentionally no `export const Config`: the row config is validated by
the settings endpoint and read with defaults in code, so the bundle needs no
`@deepseek-ai/*` dependency (a linked local bundle cannot resolve them).

## How it works

- **Host half** (`index.js`, `host/`, `github.js`): collects a snapshot through
  the signed-in `gh` CLI. Sources are the personal account (`user:<login>`) and
  each organization (`org:<login>`). For every source one GraphQL request reads
  your team memberships and runs three searches for open pull requests in
  non-archived repositories, most recently updated first:
  `review-requested:<you>` (which also matches requests to your teams),
  `reviewed-by:<you>`, and `author:<you>`. A second query searches for issues
  assigned to you, new unassigned issues, and mentions. Each PR search reads 25
  results per page and follows up to 4 pages (100 PRs); a PR found by several
  searches is listed once.
- **Branch CI** comes from a separate repository scan without pull requests: 100
  repositories per page, newest pushed first, up to 3 pages (300 repositories)
  per source, reading each repository's default-branch checks and up to 100
  branch heads.
- **Fair scheduling**: every source gets its first request before any source
  reads a second page, so one large organization cannot use up the refresh.
- **Cache and route**: results are cached (single-flight, `ttlMs`) and served to
  the panel over `GET /triage-desk/snapshot` on the Host's own web server; the
  route is fenced with the browser-trust check.
- **Aliases**: the searches run for the signed-in account only. `meLogins`
  aliases decide ownership, review requests, and activity on the PRs those
  searches return, and `includeBotReviews` applies to the same PRs; a PR that
  involves only an alias is not found.
- **Teams**: team review requests are matched against the teams you belong to
  (`teams(userLogins:)`), not against every team in the organization. When that
  membership cannot be read (for example, without the `read:org` scope or for
  nested teams), a PR that GitHub's `review-requested:` search returned is
  attributed to the first team among its requested reviewers.
- **Client half** (`client.js`): a plain-JavaScript DSH client bundle. It
  registers the sidebar panel and the page, polls the snapshot, and renders it
  with the host theme tokens. Returning to a hidden browser tab immediately
  rechecks the snapshot through the host cache; changing the interval restarts
  the timer; relative times ("updated 3 min ago") advance every minute. After a
  failed load the panel retries after 15 s, 60 s, and 5 min (each capped by the
  refresh interval), then waits for the regular poll. A stale snapshot's banner
  shows the current failure. Delayed recovery is cancelled when the last view
  unmounts or the plugin is disposed, including when an older response arrives
  afterward. No build step, no external network calls.
- **Settings** are saved through DSH's config editor into the profile patch; a
  change restarts the plugin and the panel refreshes itself. The host answers
  only after the profile write and the plugin restart complete, and only then
  does the panel show **Saved**. A failed write keeps the form open with the
  error and the edits available for retry. Settings reads started before a
  confirmed save cannot overwrite its values or status. Leaving Settings with
  unsaved edits (Back, Cancel, or the gear) asks whether to discard them or keep
  editing.
- **Launches**: scenarios are normalized and their prompts rendered in
  `launcher.js` (pure helpers: tokens, the item list block, trimming).
  `POST /triage-desk/launch` validates the scenario and URLs, resolves the clone,
  agent, terminal, and prompt delivery on the host, and only then asks the OS to
  open the terminal. `GET /triage-desk/clones` powers **Check clones** in
  Settings.
- **Failures**: transient network failures are retried once. A source whose PR
  search fails is reported as unavailable and the snapshot is partial; a failed
  issue search or branch scan keeps the source's pull requests and only makes
  the snapshot partial. When a refresh cannot scan any source (network down,
  rate limit, plugin reload), the panel and the agent tool keep the previous
  snapshot, marked stale with the reason, instead of showing an empty inbox;
  without a previous snapshot the error is reported explicitly. A permission
  denial (HTTP 403) on one source does not stop the other sources; an explicit
  rate-limit error or HTTP 429 stops further requests. A cancelled agent tool
  call stops waiting but does not cancel the shared refresh.

## Limitations

- **Coverage per refresh**: at most 10 organizations (`orgs-truncated` warning),
  100 open PRs per search and source (`prs-truncated`), and 300 repositories per
  source for branch CI (`repos-truncated`). The limits keep the most recently
  updated PRs and the most recently pushed repositories, which is not a
  guarantee that older ones have no pending work.
- **Quota**: a refresh has no fixed point budget. It stops starting queries only
  when GitHub reports a rate limit or 100 or fewer points remaining; fetched
  results are kept and a `scan-budget` warning marks the snapshot partial. By
  GitHub's documented cost formula (an estimate, not a measurement) a source
  costs about 21 points in a typical refresh and about 70 when every search and
  repository page is followed; the returned costs are recorded in the snapshot
  metadata.
- **GitHub only**: the data layer is isolated in `github.js` and the snapshot
  contract is provider-neutral, so a GitLab (or other) provider can be added
  without touching the UI.
- **PR history windows**: re-review uses `viewerLatestReview` for your own last
  review, so the review window cannot hide it. Other PR history is read in
  bounded windows: the last 50 reviews, the last 30 comments, and the last 10
  review threads with their last 5 comments each. When GitHub reports more, the
  snapshot carries a `truncated-history` warning instead of silently dropping
  them. New commits are always detected: the head commit id is compared with the
  commit your latest review was attached to.
- **Terminal tabs**: Terminal on macOS has no scripting API for creating tabs, so
  it opens a new window per launch; choose iTerm2 or Ghostty for tabs and
  focus-reuse. Ghostty tabs need Ghostty 1.4 or later. Windows tabs need Windows
  Terminal 1.5 or later. Focus-reuse works with iTerm2 and Ghostty on macOS and
  with `wmctrl` or `xdotool` on Linux (X11); Windows opens another tab in the
  shared window.
- **Paste wrapper**: it needs an agent TUI that turns on bracketed paste; an
  agent that never does, or is not ready within 2 minutes, gets no paste and the
  prompt stays on the clipboard. A folder-trust dialog is recognized by its text
  (the wording used by Claude Code, Codex, Antigravity, and Gemini CLI).
- **Windows**: PowerShell scripts are written as UTF-8 with a BOM and draft
  prompt files are read explicitly as UTF-8; a `;` in the tab title or script
  path is escaped as `\;` for Windows Terminal; double quotes in the prompt are
  escaped for PowerShell 5.1's native argument passing. A prompt argument ending
  in a backslash and agents installed as `.cmd` shims have not been verified on a
  real Windows host.
- **Linux launch errors**: launches observe immediate startup errors for 500 ms
  and then report success; the emulator keeps running without a lifetime
  timeout. Failures after that window are not reported.

## Development

Layout:

```
index.js     host plugin entry: wires host/ modules, routes, the agent tool
host/        host modules: snapshot cache and store, config, processes and terminals, agents, clones, launch
github.js    GitHub data layer: GraphQL, gh runner, snapshot normalization
launcher.js  launcher entry: re-exports launcher/ (agent commands, presets, scenarios and prompts, clone discovery, terminals, paste wrapper, scripts, terminal plans)
launcher/    launcher modules, pure helpers and platform scripts
client.js    client bundle: sidebar panel + page + settings form + scenario menus
locale/      Plugin Manager display metadata (en, zh)
icon.svg     plugin icon
docs/        this reference, the architecture map and shared contracts, the local dev workflow
dev/         smoke scripts and fixtures used while developing (not shipped in npm)
```

Setup and the default gate:

```sh
npm install           # installs ESLint + React for the render smoke and sets .githooks
npm run check         # lint + docs links + all offline smokes
npm test              # alias for npm run check
```

The pre-commit hook runs `npm run check`; it is enabled by the `prepare` script
(`git config core.hooksPath .githooks`). CI (`.github/workflows/check.yml`) runs
the same command with `npm ci`, and runs `smoke:paste` on ubuntu, macOS, and
Windows. Pull requests from organization members also get an automated review
from the DeepSeek review bot (`.github/workflows/deepseek-review.yml`); it reads
the diff through the GitHub API and never checks out or runs pull request code.
The local install and reload rules are in [DEV_LOCAL.md](DEV_LOCAL.md).

Checks:

- `npm run check:docs`: verifies that relative links and images in both READMEs
  (English and Chinese) resolve.
- `npm run smoke:client`: registers the client bundle against a fake module
  loader, checks the slot registrations, validates EN/ZH dictionary parity (key
  sets, placeholders, literal `t()` keys), and tests polling, retries, and
  visibility handling with fake timers.
- `npm run smoke:render`: renders the real `Page` and the settings screen with a
  fixture snapshot (catches components that read missing props/state and
  capability-gated controls that should be hidden), and drives settings flows,
  the minute tick, and launch-menu interactions through a deterministic hook
  runner (not a browser DOM).
- `npm run smoke:launcher`: checks scenario prompts and tokens, clone
  discovery and matching, terminal plans, the native draft launcher
  (`--prefill`), and the paste and clipboard launch scripts.
- `npm run smoke:routes`: exercises the host routes, fencing, clone scanning,
  native-picker routes, launch success and failure paths, and the launch tool
  action with a fake subprocess layer (never opens a terminal).
- `npm run smoke:cache`: checks snapshot-cache behavior: success is cached,
  failures are retried, a forced refresh during an in-flight build is queued,
  and the TTL can be supplied dynamically.
- `npm run smoke:snapshot`: runs the real snapshot builder and host cache
  against a fake `gh` that answers by GraphQL operation name (`ViewerSources`,
  `PullSearch`, `IssueSearch`, `PullSearchPage`, `BranchScan`) and rejects
  queries with unused or undeclared variables: section classification, search
  pagination and truncation, branch CI, quota stops, partial and failed sources,
  the previous snapshot kept as stale, and a cancelled tool call not cancelling
  the build.
- `npm run smoke:paste`: end-to-end check of the paste wrapper against a fake
  agent (the Python pty wrapper on macOS and Linux, the ConPTY host on Windows):
  the prompt arrives as one bracketed paste with no Enter, a folder-trust dialog
  holds the paste until Enter, an agent that never stops redrawing still gets
  the paste, and the agent's exit status is passed through.
- `npm run smoke:host`: **live, opt-in only**. Runs the host half against a fake
  Cordis context and the real `gh` CLI (requires `gh auth login`); it spends
  GitHub quota, so it is not part of `npm run check` or CI.

## Releasing (maintainers)

```sh
npm run check        # full gate; prepublishOnly runs it again on publish
npm pack --dry-run   # inspect what goes into the tarball
npm publish          # unscoped public package
```

Bump `version` in `package.json` and add a matching section to `CHANGELOG.md`.
The package ships the host and client halves, launch presets, locale metadata,
both READMEs, the changelog, the license, and `docs/REFERENCE.md`,
`docs/ARCHITECTURE.md`, and `docs/DEV_LOCAL.md`; development smokes and the
contributor docs (`AGENTS.md`, `CODING_STANDARDS.md`) stay out.

The GitHub release for the version (with the notes from the changelog) should
exist before the npm package is announced, so the `repository`, `homepage`, and
`bugs` links resolve. To list the plugin in the community market, open a pull
request against
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
that adds one `data/plugins/<owner>__<repo>.yml` entry (category `git`); the
curated list feeds [dsh-market](https://github.com/dsh-market/dsh-market) and the
DSH Discover index. The npm mapping is picked up from the published `repository`
field. `npm pack --dry-run` is a good final check that the tarball contains both
READMEs, both locale files, and the three docs.
