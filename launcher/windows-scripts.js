/**
 * Triage Desk launcher — Windows PowerShell 5.1 launcher scripts.
 */

import { terminalTitle } from './common.js'
import { assertDraftFlag, assertSafeAgentCommand, commandWords, promptWord } from './agent-command.js'

/** PowerShell 5.1 single-quoted literal: embedded quotes are doubled. */
export function windowsQuote(value) {
  return "'" + String(value).split("'").join("''") + "'"
}

function windowsTokens(command) {
  const words = commandWords(command, 'win32')
  if (words === null) throw new Error('agent command has invalid quoting')
  return words
}

function windowsScriptCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') throw new Error('cwd is required')
  if (/[\r\n\u0000]/.test(cwd)) throw new Error('cwd must be a single line')
  return 'Set-Location -LiteralPath ' + windowsQuote(cwd)
}

/** `& 'exe' '--flag' ...` for a bare command, one single-quoted argument each. */
function windowsBareInvocation(bareCommand) {
  if (typeof bareCommand !== 'string' || bareCommand.trim() === '') throw new Error('bare agent command is required')
  const tokens = windowsTokens(bareCommand)
  if (tokens.length === 0) throw new Error('bare agent command is required')
  return '& ' + tokens.map((token) => windowsQuote(token.value)).join(' ')
}

/**
 * `& 'claude' '--prefill' $prompt` for draft mode: every static token stays a
 * single-quoted argument, the token with `{prompt}` becomes the `$prompt`
 * variable, and the draft flag is inserted immediately before it. The attached
 * form becomes `('--message=' + $prompt)`: verified against about_Parsing
 * (PowerShell 5.1): in argument mode "Parentheses (`()`) begin a new
 * expression" and `()` at the start of a token creates a new parsing context,
 * so the concatenated string is passed as one argument
 * (https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-5.1).
 */
function windowsDraftInvocation(agentCommand, draftFlag) {
  assertSafeAgentCommand(agentCommand)
  assertDraftFlag(draftFlag)
  const { words, index, prefix } = promptWord(agentCommand, 'win32')
  return '& ' + words.flatMap((token, position) => {
    if (position !== index) return [windowsQuote(token.value)]
    return [windowsQuote(draftFlag), prefix === '' ? '$prompt' : '(' + windowsQuote(prefix) + ' + $prompt)']
  }).join(' ')
}

/**
 * Windows PowerShell 5.1 joins native-command arguments into one command line
 * without escaping embedded `"` (about_Parsing, "Passing arguments that
 * contain quote characters": quotes within the string must be escaped with
 * extra quotes or backslashes, and `\` is the escape of the underlying
 * ProcessStartInfo.Arguments / CommandLineToArgvW rules: 2n backslashes + `"`
 * → n backslashes and a quote delimiter; 2n+1 → n backslashes and a literal
 * quote). So every `"` in the prompt becomes `\"` with its preceding
 * backslashes doubled. This is correct only for 5.1's legacy argument passing
 * (PowerShell 7.3+ `Standard` mode escapes by itself); the launcher always
 * runs `powershell.exe`. Not verified on a real Windows host: a trailing
 * backslash inside an argument PowerShell wraps in quotes, and agents that are
 * `.cmd` shims re-parsed by cmd.exe, remain known limitations.
 */
const WINDOWS_PROMPT_QUOTE_ESCAPE = "$prompt = $prompt -replace '(\\\\*)\"', '$1$1\\\"'"

/** An exit-status report that keeps the PowerShell window open on failure. */
function windowsExitStatusLines(prefix) {
  return [
    'if ($LASTEXITCODE -ne 0) {',
    "  Write-Host ''",
    '  Write-Host (' + windowsQuote(prefix) + ' + $LASTEXITCODE)',
    '}',
  ]
}

/**
 * Builds the PowerShell 5.1 script for native draft mode on Windows: the
 * prompt is read from `promptFile` into `$prompt` and handed to the agent as a
 * single argument, so the TUI opens with an unsent draft and the prompt text
 * itself never appears in the generated script.
 */
export function buildWindowsDraftLauncherScript({ cwd, title, agentCommand, promptFile, draftFlag }) {
  if (typeof promptFile !== 'string' || promptFile.trim() === '') throw new Error('prompt file is required')
  if (/[\r\n\u0000]/.test(promptFile)) throw new Error('prompt file must be a single line')
  const invocation = windowsDraftInvocation(agentCommand, draftFlag)
  const lines = [
    '# Triage Desk launcher (native draft mode; generated for this launch).',
    windowsScriptCwd(cwd),
    '$Host.UI.RawUI.WindowTitle = ' + windowsQuote(terminalTitle(title)),
    // PowerShell 5.1 defaults BOM-less input to ANSI; prompt.txt is UTF-8.
    // Verified: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1
    '$prompt = Get-Content -Raw -LiteralPath ' + windowsQuote(promptFile) + ' -Encoding UTF8',
    'Remove-Item -LiteralPath ' + windowsQuote(promptFile) + ' -Force -ErrorAction SilentlyContinue',
    WINDOWS_PROMPT_QUOTE_ESCAPE,
    invocation,
    ...windowsExitStatusLines('Triage Desk: the agent exited with status '),
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '',
  ]
  return lines.join('\n')
}

/**
 * Builds the PowerShell 5.1 script for clipboard mode on Windows: prints the
 * clipboard hint, runs the bare agent command, and reports a non-zero exit.
 */
export function buildWindowsClipboardLauncherScript({ cwd, title, bareCommand }) {
  const invocation = windowsBareInvocation(bareCommand)
  const lines = [
    '# Triage Desk launcher (clipboard mode; generated for this launch).',
    windowsScriptCwd(cwd),
    '$Host.UI.RawUI.WindowTitle = ' + windowsQuote(terminalTitle(title)),
    "Write-Host ''",
    "Write-Host 'Triage Desk: the prompt is on your clipboard. Paste it with Ctrl+V, edit it, then send it.'",
    "Write-Host ''",
    invocation,
    ...windowsExitStatusLines('Triage Desk: the agent exited with status '),
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '',
  ]
  return lines.join('\n')
}

/**
 * Builds the PowerShell 5.1 script for the GitHub login button: runs
 * `gh auth login --web` and prints the result hint. The opener keeps the
 * window open with `-NoExit`.
 */
export function buildWindowsLoginLauncherScript({ cwd, ghCommand }) {
  if (typeof ghCommand !== 'string' || ghCommand.trim() === '') throw new Error('gh path is required')
  if (/[\r\n\u0000]/.test(ghCommand)) throw new Error('gh path must be a single line')
  const ghArgs = ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web']
  const lines = [
    '# Triage Desk GitHub login (generated for this launch).',
    windowsScriptCwd(cwd),
    "$Host.UI.RawUI.WindowTitle = 'Triage Desk: GitHub login'",
    "Write-Host ''",
    "Write-Host 'Triage Desk: follow the prompts below, finish in the browser, then return to the panel.'",
    "Write-Host ''",
    '& ' + [windowsQuote(ghCommand), ...ghArgs.map((arg) => windowsQuote(arg))].join(' '),
    'if ($LASTEXITCODE -ne 0) {',
    "  Write-Host ''",
    "  Write-Host ('Triage Desk: login exited with status ' + $LASTEXITCODE + '. You can retry from the button.')",
    '} else {',
    "  Write-Host ''",
    "  Write-Host 'Triage Desk: login finished. Return to the panel and press Check connection.'",
    '}',
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
    '',
  ]
  return lines.join('\n')
}
