# Changelog

## Unreleased

### Large organizations

- **No more failed refreshes on very large organizations.** GitHub ends a
  GraphQL request after about 10 seconds and answers HTTP 502/504; on an
  organization like `llvm` the pull request search took longer, was retried
  unchanged, and the whole refresh failed. Such a source now retries lighter:
  each search on its own with 10 pull requests per request (at most 50), then 5
  (at most 25) with shorter comment windows. The source keeps the lighter search
  until a restart or a settings save, and a `source-degraded` warning says so.
- **Large sources skip the noisy parts.** A source that needed the lighter
  search, timed out on its branch scan, or has more than 50 new unassigned
  issues in 30 days shows no new-issue list (`new-issues-skipped`), and its
  branch CI covers only the repositories you contributed to in the last year and
  the branches with your login in their name (`branch-scan-narrowed`).
- **One failed search no longer hides a source.** When a pull request search of
  a source fails, its other searches, issues and branch CI are still shown.
- **Comment bodies are read as markdown.** Mentions are matched in the stored
  comment markdown, which GitHub serves much faster than rendered text; an
  @-mention inside code or a quoted line no longer counts as a reply to you.

## [0.1.1](https://github.com/LHCWN/dsh-triage-desk/releases/tag/v0.1.1) — 2026-11-20

### Launching agents

- **Prompts are typed into the agent.** Agents without a native draft flag no
  longer open empty with the prompt on the clipboard: a small paste wrapper runs
  the agent in a pseudo-terminal, waits until its input box is ready (bracketed
  paste on and the screen settled; a folder-trust dialog waits for your Enter),
  and pastes the prompt without sending it. macOS and Linux use Python 3's `pty`
  module, Windows uses ConPTY (Windows 10 1809+) through PowerShell 5.1. Claude
  Code keeps its native `--prefill` draft (on Windows only as an `.exe`, see
  below). Verified with Codex, opencode and Antigravity; the clipboard still
  gets a copy.
- **Windows: no prompt arguments for `.cmd` agents.** A native draft
  (`claude --prefill`) is used on Windows only when the agent resolves to an
  `.exe`. An npm install (a `.cmd`/`.bat` shim) runs through `cmd.exe`, which
  re-reads the command line: quotes, `& | < > ^`, `%NAME%` and line breaks in a
  prompt would not pass intact, and an item title could run a command. Such an
  agent gets the prompt typed in (or on the clipboard), and the launch menu says
  so.
- **Windows: `.exe` shims get no prompt argument either.** A Scoop, bun,
  Chocolatey, Volta, mise or proto shim can start a `.cmd` or `cmd.exe`, so
  Claude Code installed through one of them, or reached through a symlink to
  one, gets the prompt typed in, like an npm install.
- **Windows: launches run the detected agent.** Draft, paste and clipboard
  launches start the agent by the absolute path that detection reported, as on
  macOS and Linux. A `$PROFILE` alias or function, or a different PATH order in
  the terminal, cannot start another install or shim than the one Settings
  shows. Only when detection could not run does the command run as written. A
  command that names a path rooted on the current drive (`\tools\claude.exe`)
  is reported with its drive letter, and a leading `VAR=value` word, which
  PowerShell cannot run as a prefix, makes Settings show the agent as not
  installed (**Find agents** reads such a command the same way).
- **A moved agent is detected again.** Detection results are reused for two
  minutes; when the path a launch would run is gone (the agent was moved or
  reinstalled meanwhile), the launch detects once more and runs the new path,
  on every platform.
- **Prompt delivery setting.** *Type into the agent* (default) or *Copy to
  clipboard* (`promptDelivery`: `paste` | `clipboard`). When Python 3 or ConPTY
  is missing, Settings says what to install and launches use the clipboard.
- **Terminal choice.** *Open agents in* picks Automatic or an installed terminal
  of the current platform (`terminal`): Terminal, iTerm2 or Ghostty on macOS;
  GNOME Terminal, Konsole, Xfce Terminal, Ghostty, kitty, Alacritty or xterm on
  Linux; Windows Terminal or a PowerShell window on Windows. Ghostty on macOS
  opens tabs and re-launching the same agent on an item switches to its tab. A
  chosen terminal that is not installed falls back to Automatic.
- **Launch directories are removed.** Each launcher deletes its own
  `triage-desk-*` temporary directory once nothing else is left in it, instead
  of leaving it until the 24-hour sweep.
- **Clearer launch feedback.** The toast names the agent and terminal and says
  where the prompt is; the clipboard hint shows the right keys per platform
  (⌘V, Ctrl+Shift+V, Ctrl+V) instead of always Cmd+V; each launch menu shows
  where the selected agent opens and how it gets the prompt.

### Agent tool

- **Saving settings no longer interrupts the tool.** A save is applied to the
  running plugin instead of restarting it, so a `triage_desk` call made while
  settings are being saved is answered instead of failing with
  `unknown tool "triage_desk"`. A save that leaves the GitHub settings
  unchanged (for example only agents, terminal or scenarios) keeps the cached
  snapshot instead of scanning GitHub again; after a GitHub settings change, a
  failed first scan shows the previous snapshot marked stale instead of an
  error. A config that cannot be applied live still falls back to a restart.
  The panel reads the snapshot right after a confirmed save (again after a read
  that was already running, and once more 1.5 s later if that read fails while
  a restarted plugin comes back).
- **Stale and partial snapshots are reported.** The `triage_desk` report adds a
  `Status: stale|partial — reason` line, and its header says how old the
  snapshot is.
- **An empty filter is not an empty inbox.** When the requested sections are
  empty but others are not, the report says how many items are elsewhere
  instead of "Nothing needs your attention right now."

### Windows

- **The offline gate runs on Windows.** `npm run check` passes on Windows and CI
  runs it on `windows-latest`; checks that need a POSIX shell, macOS, or symlink
  rights skip with a comment where those are missing.
- **Windows launchers are exercised for real.** `smoke:windows` runs the
  PowerShell 5.1 draft, paste and clipboard launchers with a non-ASCII
  drive-letter clone path, a prompt ending in a backslash, an npm-style `.cmd`
  shim, and `.exe`, `.cmd` and `.ps1` agents started by their detected paths;
  the `.ps1` is marked as downloaded and must run under the launch window's
  inherited `Bypass`.

### Package

- **Shorter plugin description** in both locales.
- **Uninstall is documented.** The reference documents what removing the
  plugin leaves in the profile and how to reset it.

### Development

- **`check:docs` checks anchors.** It covers every shipped Markdown file,
  checks `#section` links against the target file's headings and `<a id>`
  anchors, and fails a link whose case differs from the file on disk.

## 0.1.0 — 2026-11-15

First public release.

### Inbox data

- **Pull requests are found by search.** Each source (personal account and every
  organization) runs three searches for open PRs in non-archived repositories,
  most recently updated first: `review-requested:` (including requests to your
  teams), `reviewed-by:`, and `author:` for the signed-in account. Each search
  reads 25 PRs per page and up to 100 per source, with a `prs-truncated` warning
  beyond that; a PR found by several searches is listed once. Reading only the
  open PRs of the first repositories per source would miss PRs elsewhere.
- **Branch CI has its own repository scan.** Repositories are read without
  their PRs, 100 per page and up to 300 per source, newest pushed first, with
  the default branch's checks and up to 100 branch heads each
  (`repos-truncated` beyond that). Personal repositories get branch CI as well.
  A red default branch is listed when you administer or maintain the
  repository, or when its latest commit is yours (or a `meLogins` alias's) from
  the last week, even if the branch is not among the scanned branch heads.
- **Quota handling without a point budget.** A refresh stops starting queries
  only when GitHub reports a rate limit or 100 or fewer remaining points, and
  records a `scan-budget` warning. Sources take turns, so one large
  organization cannot starve the others. By GitHub's cost formula (an estimate,
  not a measurement) a source costs about 21 points per typical refresh and
  about 70 at most.
- **At most 10 organizations.** Explicit and auto-detected organization lists
  share the cap; more memberships produce an `orgs-truncated` warning, and
  Settings rejects more than 10.
- **Bounded review-thread history.** The last 10 review threads with their last
  5 comments each are read; older threads or comments raise
  `truncated-history`.
- **Re-review by commit id and explicit re-requests.** A PR is listed for
  re-review when its head differs from the commit your latest review was
  attached to (a commit made before your review but pushed after it counts; an
  amended committer date alone does not), or when the author clicked
  *Re-request review* for you ("the author re-requested your review").
- **Merge policy blocks are respected.** PRs GitHub marks `BLOCKED` are not
  listed as ready to merge, even when reviews and checks pass or green checks
  are optional in Triage Desk.
- **Inline review replies need action.** New reviewer comments inside review
  threads appear under *Needs your action*, even after an earlier approval; a
  later reply from you clears the comment-only action.
- **Mentions on your own items.** Unanswered follow-ups on issues and PRs you
  authored appear under *Needs your action*; self-only and answered
  conversations stay excluded.
- **Extra self logins are applied consistently.** `meLogins` decide PR
  ownership, direct review requests, your activity, and recent branch authors
  on the items found. The searches use the signed-in account only, so a PR that
  involves only an alias is not found; aliases add no sources or team
  memberships. `includeBotReviews` applies to the same PRs.
- **Team request fallback.** When team membership cannot be read, a PR returned
  by the `review-requested:` search is attributed to the first requested team.
- **Failures keep the inbox.** When no source can be scanned (quota exhausted,
  network down, plugin reload), the previous snapshot is kept and marked stale
  with the reason instead of caching an empty result. A source whose PR search
  fails is reported as unavailable; a failed branch scan only makes the
  snapshot partial. An ordinary HTTP 403 on one source does not stop the
  others; explicit rate-limit messages and HTTP 429 do. A cancelled
  `triage_desk` tool call stops waiting without cancelling the shared refresh,
  and an oversized `gh` response is not fetched a second time.

### Launch scenarios and the DSH target

- **Launch scenarios.** Named, editable prompt templates for a single row or for
  a whole section. Built-ins: *Just the link*, *Review this PR* (only on rows
  awaiting review), *Re-review after changes* (re-review rows), *Fix this PR*,
  *Reply in the thread*, and *Triage this issue*; section-wide *Review
  everything awaiting me*, *Fix my PRs*, *Triage new issues*, and *Answer
  mentions*.
- **Launch menu.** One compact target picker (**DSH — this app** plus the
  installed terminal agents) and the scenarios that apply to the row. A section
  header button launches one agent with the visible list and asks it to isolate
  each item in a separate sub-agent; the menu shows the count. Scenarios can pin
  a preferred terminal agent and show it as a badge.
- **DSH target.** The scenario prompt is rendered on the host and opened as a
  new DSH session draft through `uiWorkspace.startSession`; a blank session's
  existing draft is appended to, and nothing is submitted until Enter is
  pressed.
- **Scenario editor.** Compact list, name, scope, bound sections, prompt, agent,
  order, enabled switch, reset one or all, default scenario, and a live prompt
  preview. *Just the link* is protected and keeps `{url}`.
- **Prompt tokens.** Row `{url}`, `{repo}`, `{owner}`, `{name}`, `{number}`,
  `{title}`, `{branch}`, `{kind}`, `{ref}`, `{author}`, `{reason}`; section
  `{links}`, `{count}`, `{section}`, `{date}`. Unknown tokens stay as text, and
  the generated item list is appended when `{links}` is absent. Built-in prompts
  are English and editable; built-in scenario names follow the UI language.
- **Limits.** 30 scenarios, 4 000-character templates, 16 000-character rendered
  prompts. A section list that does not fit is trimmed with an explicit
  `Items: first N of M` and a toast warning.

### Terminal launcher

- **One shared window with tabs and focus-or-reuse.** Launches group into a
  single Triage Desk terminal window and open as tabs where the terminal
  supports them, instead of a new window every time. Re-launching the same agent
  on the same item focuses its existing tab where the platform allows it
  (iTerm2 on macOS; `wmctrl` or `xdotool` on Linux) rather than opening a
  duplicate, keyed by the window title, which now includes the agent label;
  Windows Terminal opens another tab in the shared window, and Terminal.app
  opens a new window. Focus-or-reuse is best-effort and falls back to a fresh
  tab or window when it cannot run.
- **macOS prefers iTerm2.** When iTerm2 is installed, each launch opens a tab in
  the current iTerm window (`create tab with default profile command …`, verified
  against iTerm2's AppleScript documentation) and re-launches focus the matching
  tab. Without iTerm2 the fallback is unchanged — a new Terminal.app window per
  launch, because Terminal's AppleScript cannot create a tab safely. Windows
  tabs target the shared window (`wt -w 0 new-tab`); Linux focus-or-reuse raises
  the window by title with `wmctrl -a` (or `xdotool`) when either is installed,
  both being X11 tools.
- **Agent command rule.** A command contains exactly one unquoted `{prompt}`
  after the executable word, either as its own word or directly after
  `--flag=` (for example `aider --message={prompt}`); shell operators, comments,
  and command substitutions are rejected. The host is the only place that
  checks the rule: Settings sends the form and flags the agent row the host
  names in its answer, and the launch builders apply the same check. Saved
  agents that break the rule are not dropped silently: valid agents stay
  usable, invalid ones load into Settings as editable rows marked invalid (the
  presets apply when none is valid), a scenario pinned to one shows that agent
  instead of *Default* and fails at launch with an explanation, and saving is
  blocked with a message naming the row.
- **Detection follows the login environment.** macOS uses `whence -p` in an
  interactive login zsh (`-lic`), so `~/.zshrc` PATH setup such as nvm counts;
  bash is asked as an interactive login shell (`-lic`, `type -P`), so
  `~/.bashrc` PATH setup counts too; Windows uses `Get-Command` for
  applications and scripts. Only absolute paths count: an alias to one absolute
  executable resolves to it, while other aliases and shell functions are shown
  as unavailable (*shell alias or function — use a path*). A launch runs the
  detected path and adds its directory to `PATH` when missing, so nvm shims
  find their runtime.
- **Quoted launcher words stay intact.** Detection and discovery understand
  quoted executable paths and POSIX assignment values with spaces. Clipboard
  launches preserve static quoted argument bytes; Windows scripts pass quoted
  paths and arguments as whole words and do not confuse a static `$prompt` with
  prompt data.
- **Clone discovery covers more setups.** All git remotes that point to GitHub
  count, so a fork matches through `origin` or `upstream`; SSH host aliases
  from `~/.ssh/config` whose `HostName` is `github.com` or `ssh.github.com` and
  scp remotes without `git@` are recognized. `repoPaths` match
  case-insensitively. Without configured clone directories, the existing
  typical folders are searched together with detected project roots.
  Symlinked directories are followed once, each search root has its own visit
  budget, and the clone picker derives `owner/repo` from `upstream`, then
  `origin`, then the first GitHub remote. Folders can be added with the native
  system picker; manual mappings need `owner/repo = /absolute/path` and block
  saving with a line-specific error when malformed.
- **Windows launches.** PowerShell scripts are written with a UTF-8 BOM and
  draft prompts are read as UTF-8; `;` in the Windows Terminal title or script
  path is escaped as `\;`; the window fallback is `wt -w -1 new-tab`; double
  quotes in the prompt are escaped for PowerShell 5.1 argument passing.
- **Linux terminals.** An emulator that is running after 500 ms is
  acknowledged instead of being killed by a 20-second timeout; it survives
  plugin reloads and closes when DSH quits.
- **Draft and clipboard delivery.** Claude Code uses its native `--prefill`
  draft flag (the prompt sits in the composer unsent, with a clipboard
  fallback); other agents open bare and get the prompt through the clipboard.
  When no clone is found, the terminal opens in the current workspace instead
  of failing. The launcher never clones, fetches, checks out, or changes git
  state.
- **Agent presets.** Claude Code, Codex, opencode, Gemini CLI, Cursor Agent,
  Antigravity, and pi. Detection is best-effort through the login environment;
  missing binaries are shown as *not installed*. The **Find agents** scan looks
  for the known CLIs (including Aider, Amp, Droid, Goose, and Crush) and adds the
  installed ones. The agent editor shows a name and the launch command while the
  internal id stays stable.

### Panel and settings

- **Sidebar Triage panel and sections.** An attention inbox across the personal
  GitHub account and any number of organizations: waiting for your review,
  re-review needed, ready to merge, needs your action, failing CI, and new
  unassigned issues. New issues in your repositories form a quieter "New in your
  repositories" subgroup and do not inflate the attention counter; issues
  assigned to someone else are not listed.
- **Team review requests and reviewer comments.** Team review requests are
  matched against the teams the viewer actually belongs to. Reviewer comments on
  your PRs appear as "fixes expected" under *Needs your action*, and a newer
  approval is never treated as a reply request.
- **Re-review scope.** Re-review is limited to new commits after your last
  review or the author replying **to you** after your last action. An author
  reply without new commits stays muted at the bottom of the section; other
  reviewers' activity alone does not ask for another pass.
- **Snooze.** The clock button on a row opens a snooze menu: *Until new
  activity* (default), *Until tomorrow* (09:00) or *Until next week* (Monday
  09:00). New activity (GitHub `updatedAt`, or a branch's commit) ends every
  snooze early; timed snoozes end on time without a refresh, in the list and
  the badge. A toast offers *Undo*. A *Snoozed (n)* chip opens the snoozed
  items with their return time and *Unsnooze*. Snoozes live in the browser's
  local storage (`triage-desk:snoozed:v2`; in memory when storage is
  unavailable); missing items are pruned only after a complete
  refresh. Section launches leave snoozed items out.
- **Bulk snooze.** A clock button in each section header snoozes the rows the
  section shows (source filter and search applied); in the Snoozed view it is
  *Unsnooze all (n)*. An explicit *Select* mode (next to the search field)
  adds a checkbox column before the row icons, makes rows select instead of
  opening links (Shift+click for a range within a section), adds a tri-state
  select-all checkbox to section headers and hides the row buttons; a sticky
  bar offers *Snooze* / *Unsnooze*, *Select all* / *Deselect all* and *Done*.
  Selection is per item, survives refreshes for items still shown and clears
  on a filter, source or search change; Done, Escape or a bulk action end the
  mode. One toast with one *Undo* restores the whole bulk action.
- **Honest counters.** The sidebar badge counts each item once across
  sections and leaves out optional review requests (another approval already
  satisfies the PR; the host marks them `optional`) and snoozed items. Section
  chips follow the source filter and search; the page total follows the
  source filter.
- **New unassigned issues use a fixed 30-day window.** There is no setting for
  it.
- **Snapshot loading.** A failed load is retried after 15 s, 60 s, and 5 min
  (each capped by the refresh interval), then the regular poll takes over.
  Returning to a hidden tab reloads through the host cache, changing the
  interval restarts the timer, relative times advance every minute, and the
  stale banner shows the current failure. Delayed retries are cancelled when
  the last view unmounts or the plugin is disposed.
- **Snapshot cache.** Failures are retried instead of pinned; when the GitHub
  quota is low the TTL doubles automatically; forced refreshes during an
  in-flight build are queued; a snapshot interrupted by a plugin reload is not
  cached and the panel retries it once.
- **Confirmed saves.** The host answers a settings save only after the profile
  write and the plugin restart complete (200), or with the error (500). The
  panel shows **Saved** only then and keeps the edits on failure; older
  in-flight settings reads cannot overwrite a confirmed save. Against an older
  running host that answers 202, the panel shows that the settings are being
  applied and reads them back.
- **Unsaved edits are guarded.** Leaving Settings with unsaved edits (Back,
  Cancel, or the gear) asks *Discard* or *Keep editing*.
- **Settings edits survive asynchronous results.** Folder and clone picker
  results and *Find agents* merge into the current form without reverting
  edits, resurrecting removed agents, or duplicating agents added meanwhile.
- **Invalid manual clone mappings block saving.** A nonempty line missing `=`,
  a repository, or a path shows a localized, line-specific error instead of
  being silently removed; the text stays editable.
- **Settings form.** Organizations (auto-detected when empty), personal
  repositories, auto-refresh interval (a custom value is accepted), green-CI
  merge rule, bot reviews, terminal agents, launch scenarios, and clone search.
- **Launch menus on PRs listed in two sections.** Row menu and copy state are
  kept per section, so a PR in both *Needs your action* and *CI is failing* (or
  *Ready to merge*) opens one menu. Clicking the terminal button again closes
  its menu, Escape returns focus to the button, and menus near the bottom of
  the list open upwards.
- **GitHub connection card.** Settings shows the current connection, opens an
  interactive `gh auth login` in Terminal with the **Sign in to GitHub** button,
  and says explicitly when `gh` itself is not installed.
- **UI languages and Plugin Manager metadata.** The panel follows the DSH
  interface language: English and Chinese dictionaries ship with the plugin,
  together with the locale `meta` title and description. English is the default
  and the fallback.
- **Agent tool.** `triage_desk` exposes the same snapshot and, when asked
  explicitly, opens the same terminal window. A cancelled tool call stops
  waiting without cancelling the shared refresh.
- **Default auto-refresh.** 20 minutes (cache floor 10 minutes, capped at 1
  hour), keeping a full snapshot inside the GitHub GraphQL hourly quota.

### Development

- `npm run smoke:snapshot` runs the snapshot builder against a fake `gh` that
  answers by operation name and rejects queries with unused or undeclared
  variables; it is part of `npm run check`.
- `npm run smoke:render` drives settings flows, the minute tick, and menu
  interactions through a deterministic hook runner; `npm run smoke:client`
  covers polling, retries, and visibility handling with fake timers.
- The host half is split into small modules: `index.js` wires `host/`
  (snapshot cache and store, config, processes and terminals, agent detection,
  clones, launch), and `launcher.js` re-exports `launcher/` (agent commands,
  presets, scenarios and prompts, clone discovery, POSIX and Windows scripts,
  terminal plans). The client shares one launch-menu hook between rows and
  section headers and reads prompt-preview labels from the host instead of
  keeping its own copies.
- **Guardrail.** `npm run check` (ESLint, docs links, client, render, launcher,
  route, cache and snapshot smokes), a pre-commit hook, and a CI workflow.
