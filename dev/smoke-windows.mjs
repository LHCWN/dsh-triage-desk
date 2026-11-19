/**
 * Dev smoke test that runs the generated PowerShell 5.1 launchers for real on
 * Windows (CI runs it on windows-latest through `npm run check`; elsewhere it
 * skips). A recording agent writes the arguments and working directory it
 * received, so the checks are byte-exact:
 *   - a drive-letter working directory with non-ASCII characters and `;`
 *     survives (the UTF-8 BOM makes PowerShell 5.1 read the script as UTF-8);
 *   - draft prompts with spaces, quotes and trailing backslashes, and a
 *     hostile one (`"`, `& | < > ^`, `%PATH%`, a line break), arrive at an .exe
 *     agent as one intact argument, and static arguments follow the same rules
 *     (the host drafts only an .exe, issue #5);
 *   - the clipboard launcher keeps static arguments of an npm-style `.cmd` shim;
 *   - the paste launcher types the hostile prompt into a `.cmd` shim agent
 *     intact; the command it smuggles in never runs;
 *   - paste launches run a `.cmd`, `.exe` and `.ps1` agent by the path
 *     detection reported, pinned as the host pins it (the command's own name
 *     is not on PATH); the `.ps1` runs under the launcher's Bypass
 *     (docs/REFERENCE.md#agents);
 *   - every launcher removes itself and its per-launch directory.
 *
 * Run with `npm run smoke:windows`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs, existsSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PASTE_WRAPPER_CS,
  bareAgentCommand,
  buildWindowsClipboardLauncherScript,
  buildWindowsDraftLauncherScript,
  buildWindowsPasteLauncherScript,
  sanitizePastePrompt,
  windowsQuote,
  withAgentExecutable,
} from '../launcher.js'
import { assertUnsentPaste } from './fixtures/paste.mjs'
import { removeOnExit } from './fixtures/platform.mjs'

if (process.platform !== 'win32') {
  console.log('windows smoke SKIPPED (runs only on Windows)')
  process.exit(0)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-windows-'))
removeOnExit(root)

// The recording agent and its npm-style shim live in a folder with spaces.
const tools = path.join(root, 'agent tools')
await fs.mkdir(tools, { recursive: true })
const recorder = path.join(tools, 'record-args.mjs')
await fs.writeFile(recorder, [
  "import { writeFileSync } from 'node:fs'",
  "writeFileSync(process.env.TD_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }), 'utf8')",
  '',
].join('\n'))
const shim = path.join(tools, 'record-args.cmd')
await fs.writeFile(shim, '@"' + process.execPath + '" "%~dp0record-args.mjs" %*\r\n')
// The paste smoke's fake TUI agent behind the same kind of npm-style shim.
const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs')
const agentShim = path.join(tools, 'fake-agent.cmd')
await fs.writeFile(agentShim, '@"' + process.execPath + '" "' + fakeAgent + '" %*\r\n')
// And behind an npm-style PowerShell shim, marked as downloaded
// (Zone.Identifier ZoneId=3); it records its execution policy into TD_RECORD.
const agentPs1 = path.join(tools, 'fake-agent.ps1')
await fs.writeFile(agentPs1, [
  'if ($env:TD_RECORD) {',
  '  $tdPolicy = @{ process = [string](Get-ExecutionPolicy -Scope Process); effective = [string](Get-ExecutionPolicy) }',
  '  [System.IO.File]::WriteAllText($env:TD_RECORD, ($tdPolicy | ConvertTo-Json -Compress))',
  '}',
  '& ' + windowsQuote(process.execPath) + ' ' + windowsQuote(fakeAgent) + ' @args',
  'exit $LASTEXITCODE',
  '',
].join('\r\n'))
await fs.writeFile(agentPs1 + ':Zone.Identifier', '[ZoneTransfer]\r\nZoneId=3\r\n')

// The clone directory: drive letter, non-ASCII characters, a space and `;`.
const clone = path.join(root, '工作 repo; ü')
await fs.mkdir(clone, { recursive: true })
// The temp dir can be an 8.3 short path (RUNNER~1); the agent reports the long
// one, so both sides are compared through realpathSync.native.

/**
 * A runLauncher build for paste mode: writes the prompt and the paste host
 * source into the launch directory as the host does (host/launch.js).
 */
function pasteLauncher({ bareCommand, prompt, title }) {
  return (dir) => {
    const promptFile = path.join(dir, 'prompt.txt')
    const wrapperFile = path.join(dir, 'paste-host.cs')
    writeFileSync(promptFile, sanitizePastePrompt(prompt), 'utf8')
    writeFileSync(wrapperFile, PASTE_WRAPPER_CS, 'utf8')
    return buildWindowsPasteLauncherScript({ cwd: clone, title, bareCommand, wrapperFile, promptFile })
  }
}

/** The bare command the host runs for `agentCommand` once detection found `detected`. */
function pinnedBareCommand(agentCommand, detected) {
  return bareAgentCommand(withAgentExecutable(agentCommand, detected, 'win32'), 'win32')
}

const checks = []
async function check(name, callback) {
  try {
    await callback()
    checks.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

/**
 * Writes `script` with a UTF-8 BOM, as the host does (the host's own write is
 * checked by smoke:launcher), into its own launch directory and runs it.
 */
async function runLauncher(build, timeout = 60_000) {
  // Under root, so a launcher that fails to remove it is still cleaned up.
  const dir = await fs.mkdtemp(path.join(root, 'triage-desk-'))
  const record = path.join(root, 'record-' + path.basename(dir) + '.json')
  const scriptFile = path.join(dir, 'launch.ps1')
  const script = build(dir)
  await fs.writeFile(scriptFile, '\uFEFF' + script, 'utf8')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    env: { ...process.env, TD_RECORD: record },
    encoding: 'utf8',
    timeout,
  })
  const recorded = existsSync(record) ? JSON.parse(await fs.readFile(record, 'utf8')) : null
  return { result, recorded, dirLeft: existsSync(dir) }
}

const PROMPT = 'Review C:\\work\\a b with "quotes" and a trailing backslash\\'
// cmd.exe would run `type nul > canary` if the prompt reached it on a command
// line: in `x \"y & ...` the `&` is outside cmd.exe's quotes. The canary path
// is unquoted there, and cmd.exe ends a redirection target at whitespace or
// `;` `,` `=`: such a path would send the injected write elsewhere and the
// check would pass falsely. So the canary goes in the first plain directory:
// the smoke's temp root, else the repository, else the drive root.
const PLAIN_PATH = /^[A-Za-z]:\\[\w.~\\-]*$/
async function plainDirectory() {
  if (PLAIN_PATH.test(root)) return root
  for (const base of [fileURLToPath(new URL('..', import.meta.url)), path.parse(root).root]) {
    if (!PLAIN_PATH.test(base)) continue
    const dir = await fs.mkdtemp(path.join(base, 'td-canary-'))
    removeOnExit(dir)
    return dir
  }
  throw new Error('no directory without whitespace or cmd.exe delimiters for the injection canary under ' + root)
}
const canary = path.join(await plainDirectory(), 'injected.txt')
assert.match(canary, PLAIN_PATH, 'the canary path has nothing cmd.exe would split')
const HOSTILE = 'Review x "y & type nul > ' + canary + ' & rem | more < in > out ^ caret %PATH%\n' +
  'second line: "a & b" | c < d > e ^ f %PATH% end'
assert.equal(sanitizePastePrompt(HOSTILE), HOSTILE, 'the hostile prompt has nothing the paste removes')

for (const [label, prompt] of [['the prompt', PROMPT], ['a hostile prompt', HOSTILE]]) {
  await check('draft launcher passes ' + label + ' to an .exe agent as one intact argument', async () => {
    const run = await runLauncher((dir) => {
      const promptFile = path.join(dir, 'prompt.txt')
      writeFileSync(promptFile, prompt, 'utf8')
      return buildWindowsDraftLauncherScript({
        cwd: clone,
        title: 'Triage Desk: a;b [Agent]',
        agentCommand: '"' + process.execPath + '" "' + recorder + '" {prompt}',
        promptFile,
        draftFlag: '--prefill',
      })
    })
    assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
    assert.deepEqual(run.recorded.argv, ['--prefill', prompt])
    assert.equal(realpathSync.native(run.recorded.cwd), realpathSync.native(clone), 'the non-ASCII drive-letter cwd survives')
    assert.equal(existsSync(canary), false, 'nothing in the prompt ran')
    assert.equal(run.dirLeft, false, 'the launcher removes its directory')
  })
}

await check('draft launcher keeps quoted-only spaces, bare trailing backslashes and static arguments', async () => {
  const agentCommand = '"' + process.execPath + '" "' + recorder + '" --dir "C:\\My Repos\\\\" --say \\"hi\\" {prompt}'
  for (const prompt of ['"a b"', 'plain\\', 'two\\ \\\\']) {
    const run = await runLauncher((dir) => {
      const promptFile = path.join(dir, 'prompt.txt')
      writeFileSync(promptFile, prompt, 'utf8')
      return buildWindowsDraftLauncherScript({ cwd: clone, title: 't', agentCommand, promptFile, draftFlag: '--prefill' })
    })
    assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
    assert.deepEqual(run.recorded.argv, ['--dir', 'C:\\My Repos\\', '--say', '"hi"', '--prefill', prompt], JSON.stringify(prompt))
  }
})

await check('clipboard launcher keeps static arguments of a .cmd shim', async () => {
  const run = await runLauncher(() => buildWindowsClipboardLauncherScript({
    cwd: clone,
    title: 'Triage Desk: clipboard',
    bareCommand: '"' + shim + '" --label "two words" --yes',
  }))
  assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
  assert.deepEqual(run.recorded.argv, ['--label', 'two words', '--yes'])
  // Whitespace only inside quote pairs: PowerShell 5.1 cannot pass it, so the
  // launcher switches to --% with the command-line form.
  const verbatim = await runLauncher(() => buildWindowsClipboardLauncherScript({
    cwd: clone,
    title: 'Triage Desk: clipboard',
    bareCommand: '"' + process.execPath + '" "' + recorder + '" --say "\\"a b\\"" --yes',
  }))
  assert.ok(verbatim.recorded, 'the agent ran: ' + verbatim.result.stdout + verbatim.result.stderr)
  assert.deepEqual(verbatim.recorded.argv, ['--say', '"a b"', '--yes'])
  assert.equal(verbatim.dirLeft, false)
  // PowerShell 5.1 drops an empty native argument, so it goes through --% too.
  const empty = await runLauncher(() => buildWindowsClipboardLauncherScript({
    cwd: clone,
    title: 'Triage Desk: clipboard',
    bareCommand: '"' + process.execPath + '" "' + recorder + '" --model "" --yes',
  }))
  assert.ok(empty.recorded, 'the agent ran: ' + empty.result.stdout + empty.result.stderr)
  assert.deepEqual(empty.recorded.argv, ['--model', '', '--yes'])
  assert.equal(realpathSync.native(run.recorded.cwd), realpathSync.native(clone))
  assert.equal(run.dirLeft, false)
})

// Paste launches run the program detection reported (issue #11): each
// command names a program that is not on PATH, so only the pin can start it.
await check('paste launcher types a hostile prompt into a .cmd shim agent intact, by its detected path', async () => {
  const result = path.join(root, 'paste-result.json')
  const bareCommand = pinnedBareCommand('td-not-on-path plain "' + result + '" {prompt}', agentShim)
  assert.equal(bareCommand, '"' + agentShim + '" plain "' + result + '"')
  const run = await runLauncher(pasteLauncher({ bareCommand, prompt: HOSTILE, title: 'Triage Desk: paste [Claude Code]' }), 90_000)
  const output = run.result.stdout + run.result.stderr
  assert.ok(existsSync(result), 'the agent ran: ' + output)
  assertUnsentPaste(JSON.parse(await fs.readFile(result, 'utf8')), HOSTILE, output)
  assert.doesNotMatch(output, /could not type the prompt/, 'the ConPTY host ran')
  assert.equal(existsSync(canary), false, 'nothing in the prompt ran')
  assert.equal(run.dirLeft, false, 'the launcher removes its prompt, host source and directory')
})

for (const [kind, detected, args] of [
  ['an .exe', process.execPath, '"' + fakeAgent + '" plain'],
  ['a .ps1', agentPs1, 'plain'],
]) {
  await check('paste launcher runs ' + kind + ' agent by its detected path', async () => {
    const result = path.join(root, 'pinned-' + path.extname(detected).slice(1) + '.json')
    const bareCommand = pinnedBareCommand('td-not-on-path ' + args + ' "' + result + '" {prompt}', detected)
    assert.equal(bareCommand, '"' + detected + '" ' + args + ' "' + result + '"')
    const run = await runLauncher(pasteLauncher({ bareCommand, prompt: PROMPT, title: 'Triage Desk: paste [Agent]' }), 90_000)
    const output = run.result.stdout + run.result.stderr
    assert.ok(existsSync(result), 'the agent ran: ' + output)
    assertUnsentPaste(JSON.parse(await fs.readFile(result, 'utf8')), PROMPT, output)
    assert.doesNotMatch(output, /could not type the prompt/, 'the ConPTY host ran')
    if (kind === 'a .ps1') {
      // The nested powershell.exe inherits the launcher's Process-scope Bypass.
      assert.deepEqual(run.recorded, { process: 'Bypass', effective: 'Bypass' },
        'the .ps1 agent runs under the launch window\'s Bypass: ' + output)
    }
    assert.equal(run.dirLeft, false)
  })
}

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} windows checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('windows smoke OK')
}
