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

/*
 * How Windows PowerShell 5.1 passes a native-command argument, measured on
 * windows-latest by dev/smoke-windows.mjs:
 *   - it joins arguments into one command line without escaping embedded `"`
 *     (about_Parsing, "Passing arguments that contain quote characters"); the
 *     program then splits it by CommandLineToArgvW rules, where `\` escapes a
 *     quote: 2n backslashes + `"` → n backslashes and a delimiter, 2n+1 → n
 *     backslashes and a literal quote;
 *   - it wraps an argument in quotes when whitespace appears where it has seen
 *     an even number of `"` so far (it ignores backslashes), and leaves
 *     trailing backslashes as they are.
 * So `"` becomes `\"` (its backslashes doubled) and, when 5.1 will wrap the
 * argument, trailing backslashes are doubled. An argument whose whitespace sits
 * only inside quote pairs (`"a b"` escapes to `\"a b\"`, which 5.1 does not
 * wrap) cannot be passed that way at all; it goes through the stop-parsing
 * token instead: `--%` hands the rest of the line to the program verbatim
 * after expanding `%NAME%` environment variables (about_Parsing), so the
 * launcher builds that argument's command-line form itself. This applies only
 * to 5.1's legacy passing; the launcher always runs `powershell.exe`.
 */

/** Whether PowerShell 5.1 wraps this native argument in quotes (see above). */
function psWrapsArg(value) {
  let quotes = 0
  for (const char of String(value)) {
    if (char === '"') quotes += 1
    else if (/\s/.test(char) && quotes % 2 === 0) return true
  }
  return false
}

/** `"` → `\"` with the preceding backslashes doubled. */
function escapeArgQuotes(value) {
  return String(value).replace(/(\\*)"/g, '$1$1\\"')
}

/**
 * The CommandLineToArgvW form of one argument, for a `--%` command line.
 * PowerShell expands `%NAME%` in that line, so a static argument containing
 * such text is expanded there; agent commands are trusted configuration and
 * this form is used only when 5.1 cannot pass an argument at all.
 */
function windowsCommandLineArg(value) {
  const text = String(value)
  if (text !== '' && !/[\s"]/.test(text)) return text
  return '"' + escapeArgQuotes(text).replace(/(\\+)$/, '$1$1') + '"'
}

/**
 * A static argument as PowerShell 5.1 must receive it, or null when only `--%`
 * can pass it. An empty string is null too: 5.1's legacy passing drops empty
 * arguments (PowerShell 7.3's PSNativeCommandArgumentPassing notes list
 * passing `''` as `""` among its changes), and `--%` writes it as `""`.
 */
function windowsNativeArg(value) {
  if (String(value) === '') return null
  const escaped = escapeArgQuotes(value)
  if (psWrapsArg(escaped)) return windowsQuote(escaped.replace(/(\\+)$/, '$1$1'))
  return /\s/.test(escaped) ? null : windowsQuote(escaped)
}

/**
 * PowerShell lines shared by draft launchers: `Test-TdQuoted` is psWrapsArg,
 * and `$prompt` gets its quotes escaped once it has been read from the file.
 */
const WINDOWS_PROMPT_ESCAPE_LINES = [
  "function Test-TdQuoted([string]$s) { $q = 0; foreach ($c in $s.ToCharArray()) { if ($c -eq [char]34) { $q++ } elseif ([char]::IsWhiteSpace($c) -and ($q % 2) -eq 0) { return $true } }; return $false }",
  "$prompt = $prompt -replace '(\\\\*)\"', '$1$1\\\"'",
]

/** `& 'exe' '--flag' ...` for a bare command, one single-quoted argument each. */
function windowsBareInvocation(bareCommand) {
  if (typeof bareCommand !== 'string' || bareCommand.trim() === '') throw new Error('bare agent command is required')
  const tokens = windowsTokens(bareCommand)
  if (tokens.length === 0) throw new Error('bare agent command is required')
  const [executable, ...rest] = tokens.map((token) => token.value)
  const args = rest.map(windowsNativeArg)
  if (args.includes(null)) return '& ' + windowsQuote(executable) + ' --% ' + rest.map(windowsCommandLineArg).join(' ')
  return ['& ' + windowsQuote(executable), ...args].join(' ')
}

/**
 * Draft-mode invocation lines: every static token stays an argument, the token
 * with `{prompt}` becomes the prompt, and the draft flag goes right before it.
 * The attached form `--message={prompt}` becomes `('--message=' + $prompt)`
 * (about_Parsing, 5.1: parentheses at the start of a token begin a new
 * expression, so the concatenation is one argument). When 5.1 would not wrap
 * the prompt argument although it has whitespace (or a static argument needs
 * it), the line uses `--%` with the argument in `$env:TD_PROMPT_ARG`.
 * Trailing backslashes are matched with `\z`: in .NET regex `$` also matches
 * before a final newline.
 */
function windowsDraftInvocationLines(agentCommand, draftFlag) {
  assertSafeAgentCommand(agentCommand, 'win32')
  assertDraftFlag(draftFlag)
  const { words, index, prefix } = promptWord(agentCommand, 'win32')
  const executable = '& ' + windowsQuote(words[0].value)
  const before = words.slice(1, index).map((word) => word.value)
  const after = words.slice(index + 1).map((word) => word.value)
  const nativeStatic = [...before, ...after].map(windowsNativeArg)
  const promptArg = prefix === '' ? '$tdArg' : '(' + windowsQuote(prefix) + ' + $tdArg)'
  const normal = [executable, ...before.map(windowsNativeArg), windowsQuote(draftFlag), promptArg, ...after.map(windowsNativeArg)].join(' ')
  const verbatim = [executable, '--%', ...before.map(windowsCommandLineArg), draftFlag, '%TD_PROMPT_ARG%', ...after.map(windowsCommandLineArg)].join(' ')
  const verbatimLines = [
    "  $env:TD_PROMPT_ARG = " + windowsQuote(prefix) + " + '\"' + ($prompt -replace '(\\\\+)\\z', '$1$1') + '\"'",
    '  ' + verbatim,
    '  Remove-Item Env:TD_PROMPT_ARG -ErrorAction SilentlyContinue',
  ]
  if (nativeStatic.includes(null)) return verbatimLines.map((line) => line.slice(2))
  return [
    '$tdArg = ' + (prefix === '' ? '$prompt' : windowsQuote(prefix) + ' + $prompt'),
    'if (Test-TdQuoted $tdArg) {',
    "  $tdArg = $prompt -replace '(\\\\+)\\z', '$1$1'",
    '  ' + normal,
    "} elseif ($tdArg -notmatch '\\s') {",
    '  $tdArg = $prompt',
    '  ' + normal,
    '} else {',
    ...verbatimLines,
    '}',
  ]
}

/**
 * The script removes itself, then its per-launch directory if nothing else is
 * left in it. Directory.Delete without recursion throws on a non-empty
 * directory (Remove-Item would ask for confirmation in an interactive host),
 * so leftover files are never removed by this line.
 */
const WINDOWS_SELF_CLEANUP_LINES = [
  'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue',
  'try { [System.IO.Directory]::Delete((Split-Path -Parent $PSCommandPath)) } catch { }',
]

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
  const invocation = windowsDraftInvocationLines(agentCommand, draftFlag)
  const lines = [
    '# Triage Desk launcher (native draft mode; generated for this launch).',
    windowsScriptCwd(cwd),
    '$Host.UI.RawUI.WindowTitle = ' + windowsQuote(terminalTitle(title)),
    // PowerShell 5.1 defaults BOM-less input to ANSI; prompt.txt is UTF-8.
    // Verified: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-5.1
    '$prompt = Get-Content -Raw -LiteralPath ' + windowsQuote(promptFile) + ' -Encoding UTF8',
    'Remove-Item -LiteralPath ' + windowsQuote(promptFile) + ' -Force -ErrorAction SilentlyContinue',
    ...WINDOWS_PROMPT_ESCAPE_LINES,
    ...invocation,
    ...windowsExitStatusLines('Triage Desk: the agent exited with status '),
    ...WINDOWS_SELF_CLEANUP_LINES,
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
    ...WINDOWS_SELF_CLEANUP_LINES,
    '',
  ]
  return lines.join('\n')
}

/**
 * PowerShell `-EncodedCommand` payload: base64 of the UTF-16LE script text
 * (about_PowerShell_exe, 5.1: "Accepts a base-64-encoded string version of a
 * command"), so the agent invocation needs no command-line quoting.
 */
function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Builds the PowerShell 5.1 script for paste mode on Windows: compiles the C#
 * ConPTY paste host (`wrapperFile`, see paste-wrapper.js), runs the agent in a
 * nested `powershell.exe -EncodedCommand` (so `.cmd`/`.ps1` shims resolve as
 * usual) and types the prompt from `promptFile` into its input box, unsent.
 * When the host cannot start (no ConPTY before Windows 10 1809, or a compile
 * failure) the agent runs directly and the prompt stays on the clipboard.
 */
export function buildWindowsPasteLauncherScript({ cwd, title, bareCommand, wrapperFile, promptFile }) {
  for (const [name, value] of [['wrapper file', wrapperFile], ['prompt file', promptFile]]) {
    if (typeof value !== 'string' || value.trim() === '' || /[\r\n\u0000]/.test(value)) throw new Error(name + ' is required')
  }
  const invocation = windowsBareInvocation(bareCommand)
  const lines = [
    '# Triage Desk launcher (paste mode; generated for this launch).',
    windowsScriptCwd(cwd),
    '$Host.UI.RawUI.WindowTitle = ' + windowsQuote(terminalTitle(title)),
    '$tdPrompt = ' + windowsQuote(promptFile),
    '$tdHost = ' + windowsQuote(wrapperFile),
    '$tdPasted = $false',
    'try {',
    '  Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath $tdHost -Encoding UTF8) -Language CSharp',
    // CreateProcess command line: the quoted powershell.exe path, then the
    // base64 payload (only [A-Za-z0-9+/=], so it needs no quoting).
    `  $tdCommand = '"' + (Join-Path $PSHOME 'powershell.exe') + '" -NoLogo -EncodedCommand ' + ` +
      windowsQuote(encodedCommand(invocation)),
    "  Write-Host ''",
    "  Write-Host 'Triage Desk: the prompt will appear in the agent''s input box. Review it, then press Enter.'",
    "  Write-Host ''",
    '  $global:LASTEXITCODE = [TriageDesk.PasteHost]::Run($tdCommand, $tdPrompt, (Get-Location).ProviderPath)',
    '  $tdPasted = $true',
    '} catch {',
    "  Write-Host ''",
    "  Write-Host ('Triage Desk: could not type the prompt into the agent (' + $_.Exception.Message + ').')",
    "  Write-Host 'The prompt is on your clipboard. Paste it with Ctrl+V, edit it, then send it.'",
    "  Write-Host ''",
    '}',
    'Remove-Item -LiteralPath $tdPrompt, $tdHost -Force -ErrorAction SilentlyContinue',
    'if (-not $tdPasted) {',
    '  ' + invocation,
    '}',
    ...windowsExitStatusLines('Triage Desk: the agent exited with status '),
    ...WINDOWS_SELF_CLEANUP_LINES,
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
    ...WINDOWS_SELF_CLEANUP_LINES,
    '',
  ]
  return lines.join('\n')
}
