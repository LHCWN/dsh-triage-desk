/**
 * Triage Desk launcher — per-platform plans for opening a terminal tab or
 * window on a generated launcher script.
 */

import path from 'node:path'
import { asObject } from './common.js'

/**
 * AppleScript string literal: wrap in double quotes and escape `\` and `"`.
 * AppleScript recognizes only these two escapes inside a quoted string
 * (Script Editor language guide); control characters are not expected here
 * because the only values interpolated are an absolute script path and an
 * app name chosen from a fixed set.
 */
function appleScriptString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * `xdotool search --name` matches a POSIX regular expression, not a literal
 * string, so a title containing `[Claude Code]`, `(12)`, or `.` would not match
 * itself (and could match an unrelated window). Escape every metacharacter so
 * the pattern matches the title literally.
 */
function xdotoolNamePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * iTerm2 AppleScript that runs the generated launcher as a command in a new
 * tab of the current window, or in a new window when none is open, then
 * focuses the app. Verified against iTerm2's AppleScript documentation
 * (https://iterm2.com/documentation-scripting.html, "Scripting with
 * AppleScript"): `tell current window to create tab with default profile
 * command "…"` adds a tab to the existing window and runs the command in it;
 * `create window with default profile command "…"` opens a new window. Both
 * are addressed on `application "iTerm"`. Running the launcher as the tab's
 * command (rather than `open`-ing a .command file) keeps every launch inside
 * one iTerm window instead of spawning Terminal.app windows.
 *
 * `missing value` is iTerm2's value for "no current window" (checked rather
 * than assumed, so the first launch of a session opens a window).
 */
export function buildItermTabAppleScript(scriptPath) {
  if (typeof scriptPath !== 'string' || scriptPath.trim() === '' || /[\r\n\u0000]/.test(scriptPath)) {
    throw new Error('a launcher script path is required')
  }
  // iTerm2 runs `command` through a shell, so the path is single-quoted for the
  // shell (safe for spaces and metacharacters) and then wrapped as an
  // AppleScript string literal. A literal single quote becomes '\'' .
  const shellQuoted = "'" + scriptPath.trim().split("'").join("'\\''") + "'"
  const command = appleScriptString(shellQuoted)
  return [
    'tell application "iTerm"',
    '  activate',
    '  if (count of windows) = 0 then',
    '    create window with default profile command ' + command,
    '  else',
    '    tell current window to create tab with default profile command ' + command,
    '  end if',
    'end tell',
  ].join('\n')
}

/**
 * Ghostty (1.4+) AppleScript that runs the generated launcher in a new tab of
 * the front window, or in a new window when none is open, then focuses the app.
 * Verified against the dictionary Ghostty ships (`Ghostty.app/Contents/
 * Resources/Ghostty.sdef`, 1.4.0): `new surface configuration` returns a record
 * whose `command` replaces the shell and whose `wait after command` keeps the
 * surface open; `new tab in <window> with configuration` and `new window with
 * configuration` create the surface; `count of windows` is 0 when none is open.
 * Checked on macOS 27 with Ghostty 1.4.0: the tab opens in the front window and
 * its title is then readable as `name of tab`. Ghostty runs `command` through a
 * shell, so the path is single-quoted as for iTerm2.
 */
export function buildGhosttyTabAppleScript(scriptPath) {
  if (typeof scriptPath !== 'string' || scriptPath.trim() === '' || /[\r\n\u0000]/.test(scriptPath)) {
    throw new Error('a launcher script path is required')
  }
  const shellQuoted = "'" + scriptPath.trim().split("'").join("'\\''") + "'"
  return [
    'tell application "Ghostty"',
    '  set launchConfig to new surface configuration',
    '  set command of launchConfig to ' + appleScriptString(shellQuoted),
    '  if (count of windows) = 0 then',
    '    new window with configuration launchConfig',
    '  else',
    '    new tab in front window with configuration launchConfig',
    '  end if',
    '  activate',
    'end tell',
  ].join('\n')
}

/** The macOS app a plan targets: an explicit `app`, else iTerm2 when detected, else Terminal. */
function darwinApp(input) {
  if (input.app === 'iterm' || input.app === 'ghostty' || input.app === 'terminal') return input.app
  const iterm = input.iterm === true || (typeof input.iterm === 'string' && input.iterm.trim() !== '')
  return iterm ? 'iterm' : 'terminal'
}

const WINDOWS_POWERSHELL_ARGV = [
  'powershell.exe',
  '-NoExit',
  '-NoLogo',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
]

/**
 * Pure plan for opening a terminal: the argv the host spawns plus whether it is
 * a tab or a window attempt. `capabilities` carries `scriptPath`, `title`, the
 * macOS `app` (`terminal`, `iterm` or `ghostty`; the older `iterm: true` still
 * selects iTerm2), the resolved Linux `terminal`, the win32 `wt` path (or true,
 * '' for a plain console window), and the resolved POSIX `shell`; `tab: false`
 * asks for the window fallback. The host tries the
 * tab plan first and retries with the window plan when the spawn fails.
 */
export function openTerminalPlan(platform, capabilities = {}) {
  const input = asObject(capabilities)
  const scriptPath = typeof input.scriptPath === 'string' ? input.scriptPath.trim() : ''
  if (scriptPath === '' || /[\r\n\u0000]/.test(scriptPath)) throw new Error('a launcher script path is required')
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : 'Triage Desk'
  const wantTab = input.tab !== false

  if (platform === 'darwin') {
    // iTerm2 and Ghostty have verified tab APIs: the launcher runs as the new
    // tab's command (buildItermTabAppleScript, buildGhosttyTabAppleScript).
    // Terminal.app automation cannot create a tab — `do script … in window`
    // writes into the window's current tab, corrupting a running agent's input —
    // so Terminal (and the window fallback of the others) opens a new window.
    const app = darwinApp(input)
    // `app` is the application the plan actually opens: the iTerm2 window
    // fallback (e.g. Automation permission denied) is a Terminal.app window.
    if (app === 'iterm' && wantTab) {
      return { argv: ['/usr/bin/osascript', '-e', buildItermTabAppleScript(scriptPath)], variant: 'tab', app: 'iterm' }
    }
    if (app === 'ghostty' && wantTab) {
      return { argv: ['/usr/bin/osascript', '-e', buildGhosttyTabAppleScript(scriptPath)], variant: 'tab', app: 'ghostty' }
    }
    if (app === 'ghostty') {
      return { argv: ['/usr/bin/open', '-na', 'Ghostty', '--args', '-e', scriptPath], variant: 'window', app: 'ghostty' }
    }
    return { argv: ['/usr/bin/open', '-a', 'Terminal', scriptPath], variant: 'window', app: 'terminal' }
  }

  if (platform === 'win32') {
    const wt = typeof input.wt === 'string' ? input.wt.trim() : input.wt === true ? 'wt' : ''
    const powershell = WINDOWS_POWERSHELL_ARGV.slice()
    if (wt !== '') {
      // `;` separates wt commands even inside one argv element ("Commands
      // provide the action, or list of actions separated by semicolons",
      // https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments).
      // The page documents only PowerShell's backtick, not wt's own escape;
      // verified in microsoft/terminal source instead: AppCommandlineArgs.cpp
      // splits on the regex `^;|[^\\];` and Commandline::AddArg turns every
      // `\;` back into `;`. So a literal `;` in the user-editable title (or the
      // script path) is passed as `\;`; a literal `\;` becomes `\\;` → `\;`.
      const wtArg = (value) => value.split(';').join('\\;')
      const tail = [...powershell, wtArg(scriptPath)]
      if (!wantTab) {
        // wt has no `new-window` subcommand (AppCommandlineArgs registers
        // new-tab/nt, split-pane/sp, focus-tab, move-focus, move-pane,
        // swap-pane, focus-pane, x-save); an unknown word becomes new-tab's
        // commandline. A new window is `-w -1` (or `new`) plus `new-tab`.
        return {
          argv: [wt, '-w', '-1', 'new-tab', '--title', wtArg(title), ...tail],
          variant: 'window',
        }
      }
      return {
        argv: [wt, '-w', '0', 'new-tab', '--title', wtArg(title), ...tail],
        variant: 'tab',
      }
    }
    return {
      argv: ['cmd.exe', '/c', 'start', '', ...powershell, scriptPath],
      variant: 'window',
    }
  }

  if (platform === 'linux') {
    const terminal = typeof input.terminal === 'string' ? input.terminal.trim() : ''
    if (terminal === '') {
      throw new Error(
        'no terminal emulator was found: install gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, or xterm, or set $TERMINAL',
      )
    }
    const shell = typeof input.shell === 'string' && input.shell.trim() !== '' ? input.shell.trim() : 'sh'
    const name = path.basename(terminal)
    if (name === 'gnome-terminal') {
      return {
        argv: [terminal, wantTab ? '--tab' : '--window', '--', shell, scriptPath],
        variant: wantTab ? 'tab' : 'window',
      }
    }
    if (name === 'konsole') {
      return wantTab
        ? { argv: [terminal, '--new-tab', '-e', scriptPath], variant: 'tab' }
        : { argv: [terminal, '-e', scriptPath], variant: 'window' }
    }
    if (name === 'xfce4-terminal') {
      return wantTab
        ? { argv: [terminal, '--tab', '-x', scriptPath], variant: 'tab' }
        : { argv: [terminal, '-x', scriptPath], variant: 'window' }
    }
    return { argv: [terminal, '-e', scriptPath], variant: 'window' }
  }

  throw new Error('unsupported platform: ' + String(platform))
}

/**
 * Best-effort plan to raise an already-open terminal whose title contains
 * `title`, so re-launching the same agent on the same item focuses its tab
 * instead of opening a duplicate. Returns `{ argv }` to try, or `null` when
 * the platform cannot focus by title with built-in tools — the caller then
 * falls back to opening a fresh tab/window, so a `null` is never an error.
 *
 * The title is the per-launch window title the launcher script already sets
 * via the `\033]0;…\007` OSC sequence (POSIX) or `--title`/`title` (Windows),
 * so a match means that exact agent+item tab is live.
 */
export function focusTerminalPlan(platform, capabilities = {}) {
  const input = asObject(capabilities)
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (title === '' || /[\r\n\u0000]/.test(title)) return null

  if (platform === 'darwin') {
    // iTerm2 and Ghostty: find a tab whose title contains the launch title and
    // select it. Terminal.app offers no equivalent safe lookup, so it returns
    // null and a new window opens instead.
    const app = darwinApp(input)
    const needle = appleScriptString(title)
    if (app === 'ghostty') {
      // Ghostty.sdef 1.4.0: a `window` has `tabs`, a `tab` has a `name` (its
      // title), `select tab` selects it and `activate window` raises its window.
      const script = [
        'tell application "Ghostty"',
        '  set matched to false',
        '  repeat with w in windows',
        '    repeat with t in tabs of w',
        '      if not matched and name of t contains ' + needle + ' then',
        '        select tab t',
        '        activate window w',
        '        set matched to true',
        '      end if',
        '    end repeat',
        '  end repeat',
        '  if matched then activate',
        '  return matched',
        'end tell',
      ].join('\n')
      return { argv: ['/usr/bin/osascript', '-e', script] }
    }
    if (app !== 'iterm') return null
    // Verified against iTerm2 AppleScript
    // (https://iterm2.com/documentation-scripting.html): a `window` has `tabs`,
    // a `tab` has `sessions`, a `session` has a `name`, `select` focuses a tab,
    // and `tell current tab of <window> to select`/window `select` raises it.
    const script = [
      'tell application "iTerm"',
      '  set matched to false',
      '  repeat with w in windows',
      '    repeat with t in tabs of w',
      '      repeat with s in sessions of t',
      '        if name of s contains ' + needle + ' then',
      '          tell t to select',
      '          tell w to select',
      '          set matched to true',
      '        end if',
      '      end repeat',
      '    end repeat',
      '  end repeat',
      '  if matched then activate',
      '  return matched',
      'end tell',
    ].join('\n')
    return { argv: ['/usr/bin/osascript', '-e', script] }
  }

  if (platform === 'win32') {
    // No built-in, reliable "focus a console window by its title" exists for
    // bare cmd/PowerShell, and Windows Terminal multiplexes many tabs into one
    // host window so a per-tab title cannot be raised from outside. Re-opening
    // addresses the shared `wt -w 0` window itself, which is the useful focus.
    return null
  }

  // Linux: raising a window by title needs wmctrl or xdotool, which are not
  // guaranteed to be installed; the caller passes the resolved path (or '').
  const wmctrl = typeof input.wmctrl === 'string' ? input.wmctrl.trim() : ''
  if (wmctrl !== '') {
    // `wmctrl -a <substring>` activates the first window whose title contains
    // the substring (wmctrl(1): "-a … Activate the window by switching to its
    // desktop and raising it"; match is a substring of the title).
    return { argv: [wmctrl, '-a', title] }
  }
  const xdotool = typeof input.xdotool === 'string' ? input.xdotool.trim() : ''
  if (xdotool !== '') {
    // `xdotool search --name <re> windowactivate` raises the first match;
    // --name matches the window title as a regexp (xdotool(1)), so the title is
    // escaped to a literal pattern.
    return { argv: [xdotool, 'search', '--name', xdotoolNamePattern(title), 'windowactivate'] }
  }
  return null
}
