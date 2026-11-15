/**
 * Triage Desk launcher — agent detection: one login-shell probe that locates
 * executables, its output parser, and the classification of each answer.
 */

import path from 'node:path'

/**
 * argv for one login-shell probe that locates executables. Each name prints
 * `__td__<TAB>name<TAB>path-search<TAB>command -v`; the marker lets rc-file
 * noise (even noise containing tabs) be ignored. Verified with real
 * /bin/zsh 5.9 and /bin/bash 3.2, isolated HOME/ZDOTDIR, stdin closed:
 *   - zsh `whence -p` and bash `type -P` search PATH only, ignoring aliases
 *     and functions; both print nothing for a miss;
 *   - zsh reads .zshrc only for interactive shells, so zsh runs `-lic`;
 *   - bash runs `-lic` too: with a Debian-style ~/.bashrc (sourced from the
 *     login profile, `case $- in *i*) ;; *) return;; esac` guard, nvm PATH
 *     below it) `bash -lc` found nothing, while `bash -lic` found the binary
 *     and only added "no job control in this shell" on stderr (exit 0);
 *   - `command -v` prints an absolute path for an executable, the bare name
 *     for a function or builtin, and for an alias `alias claude=/opt/x/claude`
 *     (zsh) / `alias claude='/opt/x/claude'` (bash). Non-interactive bash
 *     reports no alias at all (`bash -lc` with the alias defined in
 *     .bash_profile: `command -v` printed nothing, status 1), so aliases are
 *     only seen through the interactive probe;
 *   - an interactive shell expands rc-file aliases in the `-c` text, so
 *     `printf`/`command`/`whence`/`type` go through `builtin` (an alias named
 *     `printf` was ignored in both shells).
 * Other shells (dash, ksh, ...) use `command -v` alone with `-lc`.
 */
export function buildExecutableProbe(shell, names) {
  const base = path.basename(String(shell || ''))
  let search = ''
  let prefix = ''
  let flags = '-lc'
  if (base === 'zsh') {
    search = 'builtin whence -p -- "$__td_exe"'
    prefix = 'builtin '
    flags = '-lic'
  } else if (base === 'bash') {
    search = 'builtin type -P -- "$__td_exe"'
    prefix = 'builtin '
    flags = '-lic'
  }
  const located = search === '' ? '' : `$(${search} 2>/dev/null)`
  const script =
    'for __td_exe in "$@"; do '
    + `${prefix}printf '__td__\\t%s\\t%s\\t%s\\n' "$__td_exe" "${located}" "$(${prefix}command -v -- "$__td_exe" 2>/dev/null)"; `
    + 'done'
  return [shell, flags, script, 'triage-desk', ...names]
}

/** Parses buildExecutableProbe output into `name → { located, commandV }`. */
export function parseExecutableProbe(stdout) {
  const answers = new Map()
  for (const line of String(stdout || '').split('\n')) {
    const fields = line.split('\t')
    if (fields[0] !== '__td__' || fields.length < 4 || fields[1] === '') continue
    answers.set(fields[1], { located: fields[2].trim(), commandV: fields.slice(3).join('\t').trim() })
  }
  return answers
}

/**
 * Decides what a probe answer means for launching. Only absolute paths are
 * executables the generated script can run: an alias whose whole value is one
 * plain absolute path resolves to that path (the caller still checks it is
 * executable); any other alias, a function, or a builtin is reported, not
 * guessed at, because the launch shell never has the user's aliases.
 * Returns `{ path }` or `{ path: null, reason: 'alias' | 'function' | 'missing' }`.
 */
export function classifyProbeAnswer(answer, platform = process.platform) {
  const isAbsolute = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute
  const located = answer && typeof answer.located === 'string' ? answer.located : ''
  const commandV = answer && typeof answer.commandV === 'string' ? answer.commandV : ''
  const alias = commandV.match(/^alias\s+[^=\s]+=(.*)$/)
  if (alias !== null) {
    let value = alias[1]
    if (/^'[^']*'$/.test(value)) value = value.slice(1, -1)
    if (/^\/[A-Za-z0-9._/+@%:,=-]+$/.test(value)) return { path: value, via: 'alias' }
  }
  if (located !== '' && isAbsolute(located)) return { path: located }
  if (alias === null && commandV !== '' && isAbsolute(commandV)) return { path: commandV }
  if (alias !== null) return { path: null, reason: 'alias' }
  if (commandV !== '') return { path: null, reason: 'function' }
  return { path: null, reason: 'missing' }
}
