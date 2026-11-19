/**
 * Triage Desk launcher — the agent command rule and the transformations of a
 * validated agent command: shell word splitting (POSIX and Windows argv
 * rules), the `{prompt}` placeholder rule shared by config validation,
 * normalization and the script builders, POSIX single-quote quoting, and the
 * command variants (draft flag, bare/clipboard, prefill, pinned executable).
 */

import path from 'node:path'

export function shellQuote(value) {
  const text = String(value)
  return "'" + text.split("'").join("'\\''") + "'"
}

/**
 * Split command words without evaluating expansions. Raw spans let clipboard
 * mode remove only the prompt words, preserving all other shell source bytes.
 */
export function commandWords(command, platform = process.platform) {
  if (typeof command !== 'string' || /[\r\n\u0000]/.test(command)) return null
  const words = []
  let start = -1
  let value = ''
  let quote = null
  const flush = (end) => {
    if (start === -1) return
    words.push({ raw: command.slice(start, end), value, start, end })
    start = -1
    value = ''
  }
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === null && /[ \t]/.test(char)) {
      flush(index)
      continue
    }
    if (start === -1) start = index
    if (quote === "'") {
      if (char === "'") quote = null
      else value += char
      continue
    }
    if (char === '\\') {
      if (platform === 'win32') {
        // Native backslashes are literal except immediately before double
        // quotes: 2n toggle quoting; 2n+1 produce a literal quote (Microsoft).
        // https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw
        let end = index
        while (command[end] === '\\') end += 1
        const count = end - index
        if (command[end] === '"') {
          value += '\\'.repeat(Math.floor(count / 2))
          if (count % 2) value += '"'
          else quote = quote === '"' ? null : '"'
          index = end
        } else {
          value += '\\'.repeat(count)
          index = end - 1
        }
      } else {
        const next = command[index + 1]
        if (next === undefined) return null
        if (quote === null || ['$', '`', '"', '\\'].includes(next)) {
          value += next
          index += 1
        } else value += char
      }
      continue
    }
    if (char === '"' || (quote === null && char === "'")) {
      quote = quote === char ? null : char
    } else value += char
  }
  if (quote !== null) return null
  flush(command.length)
  return words
}

const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * First executable word, ignoring complete (possibly quoted) VAR=... values.
 * On Windows it is the first word: PowerShell has no `VAR=value cmd` form, so
 * a leading assignment is the program it would run (and detection looks it up).
 */
export function agentExecutable(command, platform = process.platform) {
  const words = commandWords(command, platform)
  if (words === null) return ''
  const executable = platform === 'win32' ? words[0] : words.find((word) => !ASSIGNMENT_WORD.test(word.raw))
  return executable?.value || ''
}

const PROMPT_TOKEN = '{prompt}'
/** `--message=` style prefix allowed directly before `{prompt}` in one unquoted word. */
const PROMPT_FLAG_PREFIX = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*=$/

/** The single user-facing statement of the agent command rule (config POST and builders). */
export const AGENT_COMMAND_RULE =
  'command must contain exactly one {prompt} as its own unquoted argument or as --flag={prompt}, after the executable, '
  + 'without shell operators, comments, or $( ) ${ } backtick expansions'

/**
 * Throws unless `command` follows the agent command rule. On Windows a first
 * word that is not `VAR=value` is checked as a plain program name: it may be a
 * detected path pinned by withAgentExecutable, and every Windows builder runs
 * it as a PowerShell literal (`& '<path>'`), where a backtick or `$(` is
 * literal too. Only those checks are skipped: a `{prompt}` in that word
 * still breaks the rule.
 */
export function assertSafeAgentCommand(command, platform) {
  const first = platform === 'win32' ? commandWords(command, 'win32')?.[0] : undefined
  const plainProgram = first !== undefined && !ASSIGNMENT_WORD.test(first.raw)
  if (plainProgram && first.raw.includes(PROMPT_TOKEN)) throw new Error('agent ' + AGENT_COMMAND_RULE)
  const checked = plainProgram ? 'agent' + command.slice(first.end) : command
  if (!hasSafePromptPlaceholder(checked)) throw new Error('agent ' + AGENT_COMMAND_RULE)
}

/**
 * Prompt replacement supplies its own shell quoting, so the placeholder's
 * context must be static. The rule (mirrored by the client editor):
 *   - one line, exactly one `{prompt}`;
 *   - no backtick and no `$(` `${` `$[` `$"` `$'` anywhere, even inside quotes:
 *     nested expansions carry their own quote stack;
 *   - no unquoted `; & | < > ( )` and no unquoted `#` at a word start;
 *   - `{prompt}` is unquoted and follows at least one executable word (a word
 *     that is not a `VAR=value` assignment), so prompt text never chooses the
 *     command;
 *   - `{prompt}` is a whole word, or ends an unquoted word whose prefix is
 *     `-x=`/`--long-flag=`, and is followed by a blank or the end.
 * Substituting shellQuote(prompt) there yields either one quoted word or
 * `--flag='...'`, which POSIX sh concatenates into one literal argument (the
 * offline smoke runs both through real /bin/sh with $(...), backticks and
 * quotes in the prompt). This is a context check for trusted user command
 * code, not a sandbox.
 */
export function hasSafePromptPlaceholder(command) {
  if (typeof command !== 'string' || /[\r\n\u0000]/.test(command)) return false
  if (command.split(PROMPT_TOKEN).length !== 2) return false
  if (/`|\$[({["']/.test(command)) return false
  let quote = null
  let wordStart = -1
  let hasExecutable = false
  let found = false
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (char === '\\') index += 1
      else if (char === '"') quote = null
      continue
    }
    if (char === ' ' || char === '\t') {
      if (wordStart !== -1 && !ASSIGNMENT_WORD.test(command.slice(wordStart, index))) hasExecutable = true
      wordStart = -1
      continue
    }
    const atWordStart = wordStart === -1
    if (atWordStart) wordStart = index
    if (char === '\\') {
      index += 1
      if (index === command.length) return false
      continue
    }
    if (/[;&|<>()]/.test(char) || (char === '#' && atWordStart)) return false
    if (char === "'" || char === '"') {
      quote = char
      continue
    }
    if (command.startsWith(PROMPT_TOKEN, index)) {
      const prefix = command.slice(wordStart, index)
      const after = command[index + PROMPT_TOKEN.length]
      if (!hasExecutable) return false
      if (prefix !== '' && !PROMPT_FLAG_PREFIX.test(prefix)) return false
      if (after !== undefined && after !== ' ' && after !== '\t') return false
      found = true
      index += PROMPT_TOKEN.length - 1
    }
  }
  return found && quote === null
}

/**
 * The word carrying `{prompt}` in an already validated command: `prefix` is
 * '' for a whole word or `--flag=` for the attached form.
 */
export function promptWord(command, platform) {
  const words = commandWords(command, platform)
  if (words === null) throw new Error('agent command has invalid quoting')
  const index = words.findIndex((word) => word.raw.endsWith(PROMPT_TOKEN))
  if (index === -1) throw new Error('agent command must contain {prompt}')
  const word = words[index]
  return { words, index, word, prefix: word.raw.slice(0, -PROMPT_TOKEN.length) }
}

/** A native draft flag is one plain long option, e.g. `--prefill`. */
export const DRAFT_FLAG_PATTERN = /^--[A-Za-z0-9-]+$/

export function assertDraftFlag(draftFlag) {
  if (typeof draftFlag !== 'string' || !DRAFT_FLAG_PATTERN.test(draftFlag)) {
    throw new Error('a valid draft flag is required')
  }
}

/**
 * The agent command without the prompt placeholder: used by clipboard mode, where
 * the agent starts bare and the prompt is pasted by the user.
 */
export function bareAgentCommand(agentCommand, platform = process.platform) {
  assertSafeAgentCommand(agentCommand, platform)
  const { words, index, word, prefix } = promptWord(agentCommand, platform)
  // `--message={prompt}` carries its own flag: drop that one word. A whole
  // `{prompt}` word also drops a directly preceding value-less flag such as
  // `--prompt`; `--model=opus {prompt}` keeps its complete flag.
  const previous = index > 0 ? words[index - 1] : null
  const first = prefix === '' && previous !== null && previous.value.startsWith('-') && !previous.value.includes('=')
    ? previous
    : word
  const before = agentCommand.slice(0, first.start).trimEnd()
  const after = agentCommand.slice(word.end).trimStart()
  const bare = [before, after].filter(Boolean).join(' ')
  if (bare === '') throw new Error('agent command has no executable after removing the prompt')
  return bare
}

/**
 * Builds the shell command for agents with a native draft flag, e.g.
 * `claude --prefill '<prompt>'`: the TUI opens with the prompt in its input box
 * and nothing submitted. The draft flag becomes its own word directly before
 * the prompt word (`x --prefill --message='<prompt>'` for the attached form).
 */
export function buildDraftCommand(agentCommand, prompt, draftFlag) {
  assertSafeAgentCommand(agentCommand)
  assertDraftFlag(draftFlag)
  const { word } = promptWord(agentCommand, 'linux')
  const templated = agentCommand.slice(0, word.start) + draftFlag + ' ' + agentCommand.slice(word.start)
  return templated.replace(PROMPT_TOKEN, () => shellQuote(prompt))
}

/**
 * Pins the command's executable to the absolute path agent detection found, so
 * detection and launch run the same program even when the launch shell has
 * other aliases, functions or PATH order (docs/REFERENCE.md#agents). Returns
 * the command unchanged when there is no usable path.
 *
 * POSIX: the first non-assignment word is replaced (shell-quoted when needed);
 * an already path-qualified executable is kept. Windows: windowsPin.
 */
export function withAgentExecutable(agentCommand, executablePath, platform = process.platform) {
  if (platform === 'win32') return windowsPin(agentCommand, executablePath)?.command ?? agentCommand
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) return agentCommand
  if (/[\r\n\u0000]/.test(executablePath)) return agentCommand
  const words = commandWords(agentCommand, platform)
  if (words === null) return agentCommand
  const executable = words.find((word) => !ASSIGNMENT_WORD.test(word.raw))
  if (executable === undefined || executable.raw.endsWith(PROMPT_TOKEN) || executable.value.includes('/')) {
    return agentCommand
  }
  const quoted = /^[A-Za-z0-9_@%+=:,./-]+$/.test(executablePath) ? executablePath : shellQuote(executablePath)
  const pinned = agentCommand.slice(0, executable.start) + quoted + agentCommand.slice(executable.end)
  return hasSafePromptPlaceholder(pinned) ? pinned : agentCommand
}

/**
 * The detected path as the Windows pin writes it: trimmed and normalized
 * (`/` becomes `\`; an absolute path written in the agent command skips the
 * probe's trimming), with a drive or UNC root, or null. `\x` and `C:x` stay
 * drive-relative after normalizing, so they are rejected: the current drive
 * can differ between detection and the launch's cwd. A Windows path cannot
 * contain `"`, so the quoted pin stays one word; a `{prompt}` in it would
 * break the command rule (assertSafeAgentCommand).
 */
function windowsPinPath(detectedPath) {
  const trimmed = typeof detectedPath === 'string' ? detectedPath.trim() : ''
  if (trimmed === '' || /[\r\n\u0000"]/.test(trimmed) || trimmed.includes(PROMPT_TOKEN)) return null
  const normalized = path.win32.normalize(trimmed)
  return /^(?:[A-Za-z]:\\|\\\\)/.test(normalized) ? normalized : null
}

/**
 * The Windows pin: `{ command, path }` with the first word replaced by the
 * detected path (windowsPinPath, double-quoted), or null when there is no such
 * path. See docs/REFERENCE.md#agents.
 */
function windowsPin(agentCommand, detectedPath) {
  const normalized = windowsPinPath(detectedPath)
  if (normalized === null) return null
  const first = commandWords(agentCommand, 'win32')?.[0]
  if (first === undefined) return null
  // Trailing backslashes are doubled so the closing quote stays a quote (CommandLineToArgvW).
  const word = '"' + normalized.replace(/(\\+)$/, '$1$1') + '"'
  return { command: agentCommand.slice(0, first.start) + word + agentCommand.slice(first.end), path: normalized }
}

/**
 * The path a Windows native draft would pin (windowsPinPath) when it is an
 * `.exe`, else null; isWindowsShim checks the same path. Only a resolved
 * `.exe` can take the prompt as a command-line argument: the case the
 * PowerShell 5.1 argument rules in windows-scripts.js were measured against
 * (dev/smoke-windows.mjs). A `.cmd`/`.bat` runs through `cmd.exe`
 * (CreateProcess documentation: a batch file needs the command interpreter,
 * `cmd.exe /c`), which parses the line again and does not treat `\"` as an
 * escaped quote: `& | < > ^` can fall outside its quotes and act as operators,
 * `%NAME%` is expanded and a line break ends the command (issue #5; the
 * "BatBadBut" class, CVE-2024-24576). A `.ps1` shim re-passes the argument
 * through another layer that was not measured, and an unresolved path is
 * unknown. Those agents get the prompt typed in or on the clipboard instead.
 */
export function windowsDraftExecutable(detectedPath) {
  const executablePath = windowsPinPath(detectedPath)
  return executablePath !== null && /\.exe$/i.test(executablePath) ? executablePath : null
}

/**
 * The one decision whether a launch may use the agent's native draft flag:
 * the command to run with it, or null when the prompt must be typed in or
 * copied instead. `detectedPath` is the path agent detection resolved ('' when
 * none) and `shim` whether isWindowsShim found a shim layout there. The
 * executable is pinned as withAgentExecutable does; on Windows the pinned path
 * must also be an `.exe` (windowsDraftExecutable) that is not a shim, which may
 * start `cmd.exe`. Windows drafts only when `shim` is exactly `false`, so a
 * call that skipped the check gets no draft. Internal: callers use
 * draftCommandForStatus.
 */
function draftCommandFor(agent, detectedPath, platform, shim) {
  if (typeof agent.draftFlag !== 'string') return null
  if (platform !== 'win32') return withAgentExecutable(agent.command, detectedPath, platform)
  if (shim !== false) return null
  const pin = windowsPin(agent.command, detectedPath)
  return pin !== null && windowsDraftExecutable(pin.path) !== null ? pin.command : null
}

/**
 * draftCommandFor for an agent detection status (`{ available, path, shim? }`
 * from detectAgents), so the launch and the launch menu's `draft` flag decide
 * alike. The one entry point of the draft decision.
 */
export function draftCommandForStatus(agent, status, platform = process.platform) {
  const found = status !== undefined && status !== null && status.available === true
  const detectedPath = found && typeof status.path === 'string' ? status.path : ''
  return draftCommandFor(agent, detectedPath, platform, found ? status.shim : undefined)
}
