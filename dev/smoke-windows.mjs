/**
 * Dev smoke test that runs the generated PowerShell 5.1 launchers for real on
 * Windows (CI runs it on windows-latest through `npm run check`; elsewhere it
 * skips). A recording agent writes the arguments and working directory it
 * received, so the checks are byte-exact:
 *   - a drive-letter working directory with non-ASCII characters and `;`
 *     survives (the UTF-8 BOM makes PowerShell 5.1 read the script as UTF-8);
 *   - prompts with spaces, quotes and trailing backslashes arrive as one
 *     argument, for an .exe agent and for an npm-style `.cmd` shim, and static
 *     arguments follow the same rules;
 *   - the clipboard launcher keeps static arguments;
 *   - a hostile prompt (`"`, `& | < > ^`, `%PATH%`, a line break) reaches an
 *     .exe agent intact as a draft argument, and is typed into a `.cmd` shim
 *     through the paste launcher (the host never passes a prompt argument to
 *     a `.cmd`/`.bat`, issue #5); the command it smuggles in never runs;
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
  buildWindowsClipboardLauncherScript,
  buildWindowsDraftLauncherScript,
  buildWindowsPasteLauncherScript,
  sanitizePastePrompt,
} from '../launcher.js'
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

// The clone directory: drive letter, non-ASCII characters, a space and `;`.
const clone = path.join(root, '工作 repo; ü')
await fs.mkdir(clone, { recursive: true })
// The temp dir can be an 8.3 short path (RUNNER~1); the agent reports the long
// one, so both sides are compared through realpathSync.native.

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
async function runLauncher(build) {
  // Under root, so a launcher that fails to remove it is still cleaned up.
  const dir = await fs.mkdtemp(path.join(root, 'triage-desk-'))
  const record = path.join(root, 'record-' + path.basename(dir) + '.json')
  const scriptFile = path.join(dir, 'launch.ps1')
  const script = build(dir)
  await fs.writeFile(scriptFile, '\uFEFF' + script, 'utf8')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    env: { ...process.env, TD_RECORD: record },
    encoding: 'utf8',
    timeout: 90_000,
  })
  const recorded = existsSync(record) ? JSON.parse(await fs.readFile(record, 'utf8')) : null
  return { result, recorded, dirLeft: existsSync(dir) }
}

const PROMPT = 'Review C:\\work\\a b with "quotes" and a trailing backslash\\'

for (const [label, agentCommand] of [
  ['an .exe agent', '"' + process.execPath + '" "' + recorder + '" {prompt}'],
  ['an npm-style .cmd shim', '"' + shim + '" {prompt}'],
]) {
  await check('draft launcher passes the prompt to ' + label + ' as one argument', async () => {
    const run = await runLauncher((dir) => {
      const promptFile = path.join(dir, 'prompt.txt')
      writeFileSync(promptFile, PROMPT, 'utf8')
      return buildWindowsDraftLauncherScript({
        cwd: clone,
        title: 'Triage Desk: a;b [Agent]',
        agentCommand,
        promptFile,
        draftFlag: '--prefill',
      })
    })
    assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
    assert.deepEqual(run.recorded.argv, ['--prefill', PROMPT])
    assert.equal(realpathSync.native(run.recorded.cwd), realpathSync.native(clone), 'the non-ASCII drive-letter cwd survives')
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

// cmd.exe would run `type nul > canary` if the prompt reached it on a command
// line: in `x \"y & ...` the `&` is outside cmd.exe's quotes.
const canary = path.join(root, 'injected.txt')
const HOSTILE = 'Review x "y & type nul > ' + canary + ' & rem | more < in > out ^ caret %PATH%\n' +
  'second line: "a & b" | c < d > e ^ f %PATH% end'
assert.equal(sanitizePastePrompt(HOSTILE), HOSTILE, 'the hostile prompt has nothing the paste removes')

await check('draft launcher passes a hostile prompt to an .exe agent intact', async () => {
  const run = await runLauncher((dir) => {
    const promptFile = path.join(dir, 'prompt.txt')
    writeFileSync(promptFile, HOSTILE, 'utf8')
    return buildWindowsDraftLauncherScript({
      cwd: clone,
      title: 't',
      agentCommand: '"' + process.execPath + '" "' + recorder + '" {prompt}',
      promptFile,
      draftFlag: '--prefill',
    })
  })
  assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
  assert.deepEqual(run.recorded.argv, ['--prefill', HOSTILE])
  assert.equal(existsSync(canary), false, 'nothing in the prompt ran')
  assert.equal(run.dirLeft, false)
})

await check('paste launcher types a hostile prompt into a .cmd shim agent intact', async () => {
  const result = path.join(root, 'paste-result.json')
  const run = await runLauncher((dir) => {
    const promptFile = path.join(dir, 'prompt.txt')
    const wrapperFile = path.join(dir, 'paste-host.cs')
    // As the host writes them (host/launch.js, paste mode).
    writeFileSync(promptFile, sanitizePastePrompt(HOSTILE), 'utf8')
    writeFileSync(wrapperFile, PASTE_WRAPPER_CS, 'utf8')
    return buildWindowsPasteLauncherScript({
      cwd: clone,
      title: 'Triage Desk: paste [Claude Code]',
      bareCommand: '"' + agentShim + '" plain "' + result + '"',
      wrapperFile,
      promptFile,
    })
  })
  const output = run.result.stdout + run.result.stderr
  assert.ok(existsSync(result), 'the agent ran: ' + output)
  const recorded = JSON.parse(await fs.readFile(result, 'utf8'))
  const paste = recorded.events.find((event) => event.type === 'paste')
  assert.ok(paste, 'the agent received a paste: ' + JSON.stringify(recorded) + output)
  assert.equal(paste.text, HOSTILE, 'the prompt is typed in byte for byte')
  assert.equal(paste.before, '', 'nothing is typed before the paste')
  assert.doesNotMatch(output, /could not type the prompt/, 'the ConPTY host ran')
  assert.equal(existsSync(canary), false, 'nothing in the prompt ran')
  assert.equal(run.dirLeft, false, 'the launcher removes its prompt, host source and directory')
})

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} windows checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('windows smoke OK')
}
