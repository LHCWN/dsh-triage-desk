/**
 * Triage Desk launcher — POSIX launcher scripts: the zsh `.command` files for
 * macOS Terminal and the `/bin/sh` scripts for Linux emulators.
 */

import path from 'node:path'
import { terminalTitle } from './common.js'
import { shellQuote } from './agent-command.js'

/**
 * POSIX launcher shell for a platform. macOS keeps the original zsh script
 * byte-for-byte; Linux uses a portable `/bin/sh` script whose interactive
 * fallback shell is whatever `$SHELL` points at.
 */
function posixLauncherShell(platform) {
  if (platform === 'linux') return { shebang: '#!/bin/sh', interactive: '"${SHELL:-/bin/sh}" -i' }
  return { shebang: '#!/bin/zsh', interactive: '/bin/zsh -i' }
}

function assertAbsoluteCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('cwd must be absolute')
}

/**
 * Lines that put the detected agent's directory on PATH when it is missing.
 * How the launch shell gets its PATH (verified): macOS Terminal opens a
 * `.command` file by typing `<path> ; exit;` into a new interactive login
 * shell (the `%@ ; exit;` format string in Terminal.app's binary), so the
 * script inherits that shell's exported PATH but none of its aliases or
 * functions; Linux emulators are spawned by DSH with DSH's own environment and
 * run the script directly (`#!/bin/sh`, non-interactive), so rc-file PATH
 * entries (nvm, ~/.local/bin) are absent there. Prepending only when missing
 * keeps the user's order in the first case and lets `#!/usr/bin/env node`
 * shims find their runtime next to the binary in the second.
 */
function agentPathLines(binDir) {
  if (typeof binDir !== 'string' || binDir === '' || !path.isAbsolute(binDir)) return []
  if (/[\r\n\u0000:]/.test(binDir)) return []
  const dir = shellQuote(binDir)
  return [`case ":$PATH:" in *:${dir}:*) ;; *) PATH=${dir}"\${PATH:+:\$PATH}"; export PATH ;; esac`]
}

/**
 * Builds the `.command` script for native draft mode: the agent starts with the
 * prompt already in its composer (unsent), and a shell is kept after exit.
 */
export function buildDraftLauncherScript({ cwd, title, command, binDir, platform = 'darwin' }) {
  if (typeof command !== 'string' || command.trim() === '') throw new Error('draft command is required')
  assertAbsoluteCwd(cwd)
  const displayTitle = terminalTitle(title)
  const shell = posixLauncherShell(platform)
  const lines = [
    shell.shebang,
    '# Triage Desk launcher (native draft mode; generated for this launch).',
    'rm -f -- "$0"',
    'cd -- ' + shellQuote(cwd) + ' || {',
    "  printf 'Triage Desk: the clone directory is gone: %s\\n' " + shellQuote(cwd),
    '  exec ' + shell.interactive,
    '}',
    "printf '\\033]0;%s\\007' " + shellQuote(displayTitle),
    ...agentPathLines(binDir),
    command,
    'TD_STATUS=$?',
    'if [ "$TD_STATUS" -ne 0 ]; then',
    "  printf '\\nTriage Desk: the agent exited with status %s\\n' \"$TD_STATUS\"",
    'fi',
    'exec ' + shell.interactive,
    '',
  ]
  return lines.join('\n')
}

/**
 * Builds the `.command` script for the GitHub login button: runs
 * `gh auth login --web` in Terminal and leaves the window open.
 */
export function buildLoginLauncherScript({ cwd, ghCommand, platform = 'darwin' }) {
  if (typeof ghCommand !== 'string' || !path.isAbsolute(ghCommand)) throw new Error('gh path must be absolute')
  assertAbsoluteCwd(cwd)
  const shell = posixLauncherShell(platform)
  const lines = [
    shell.shebang,
    '# Triage Desk GitHub login (generated for this launch).',
    'rm -f -- "$0"',
    'cd -- ' + shellQuote(cwd) + ' || exec ' + shell.interactive,
    "printf '\\nTriage Desk: follow the prompts below, finish in the browser, then return to the panel.\\n\\n'",
    shellQuote(ghCommand) + ' auth login --hostname github.com --git-protocol https --web',
    'TD_STATUS=$?',
    'if [ "$TD_STATUS" -ne 0 ]; then',
    "  printf '\\nTriage Desk: login exited with status %s. You can retry from the button.\\n' \"$TD_STATUS\"",
    'else',
    "  printf '\\nTriage Desk: login finished. Return to the panel and press Check connection.\\n'",
    'fi',
    'exec ' + shell.interactive,
    '',
  ]
  return lines.join('\n')
}

/**
 * Builds the `.command` script for clipboard mode: starts the agent without a
 * prompt, tells the user the prompt is on the clipboard, and keeps a shell once
 * the agent exits.
 */
export function buildClipboardLauncherScript({ cwd, title, bareCommand, binDir, platform = 'darwin' }) {
  if (typeof bareCommand !== 'string' || bareCommand.trim() === '') throw new Error('bare agent command is required')
  assertAbsoluteCwd(cwd)
  const displayTitle = terminalTitle(title)
  const shell = posixLauncherShell(platform)
  const lines = [
    shell.shebang,
    '# Triage Desk launcher (clipboard mode; generated for this launch).',
    'rm -f -- "$0"',
    'cd -- ' + shellQuote(cwd) + ' || {',
    "  printf 'Triage Desk: the clone directory is gone: %s\\n' " + shellQuote(cwd),
    '  exec ' + shell.interactive,
    '}',
    "printf '\\033]0;%s\\007' " + shellQuote(displayTitle),
    "printf '\\nTriage Desk: the prompt is on your clipboard. Paste it with Cmd+V, edit it, then send it.\\n\\n'",
    ...agentPathLines(binDir),
    bareCommand,
    'TD_STATUS=$?',
    'if [ "$TD_STATUS" -ne 0 ]; then',
    "  printf '\\nTriage Desk: the agent exited with status %s\\n' \"$TD_STATUS\"",
    'fi',
    'exec ' + shell.interactive,
    '',
  ]
  return lines.join('\n')
}
