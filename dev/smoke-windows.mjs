/**
 * Dev smoke test that runs the generated PowerShell 5.1 launchers for real on
 * Windows (CI runs it on windows-latest through `npm run check`; elsewhere it
 * skips). A recording agent writes the arguments and working directory it
 * received, so the checks are byte-exact:
 *   - a drive-letter working directory with non-ASCII characters and `;`
 *     survives (the UTF-8 BOM makes PowerShell 5.1 read the script as UTF-8);
 *   - a prompt with spaces, quotes and a trailing backslash arrives as one
 *     argument, for an .exe agent and for an npm-style `.cmd` shim;
 *   - the clipboard launcher keeps static arguments;
 *   - every launcher removes itself and its per-launch directory.
 *
 * Run with `npm run smoke:windows`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs, existsSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWindowsClipboardLauncherScript, buildWindowsDraftLauncherScript } from '../launcher.js'

if (process.platform !== 'win32') {
  console.log('windows smoke SKIPPED (runs only on Windows)')
  process.exit(0)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-windows-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

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

// The clone directory: drive letter, non-ASCII characters, a space and `;`.
const clone = path.join(root, '工作 repo; ü')
await fs.mkdir(clone, { recursive: true })

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

/** Writes `script` like the host does (UTF-8 BOM) into its own launch directory and runs it. */
async function runLauncher(build) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-'))
  const record = path.join(root, 'record-' + path.basename(dir) + '.json')
  const scriptFile = path.join(dir, 'launch.ps1')
  const script = build(dir)
  await fs.writeFile(scriptFile, '\uFEFF' + script, 'utf8')
  const head = (await fs.readFile(scriptFile)).subarray(0, 3).toString('hex')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
    env: { ...process.env, TD_RECORD: record },
    encoding: 'utf8',
    timeout: 60_000,
  })
  const recorded = existsSync(record) ? JSON.parse(await fs.readFile(record, 'utf8')) : null
  return { head, result, recorded, dirLeft: existsSync(dir) }
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
    assert.equal(run.head, 'efbbbf', 'the script starts with a UTF-8 BOM')
    assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
    assert.deepEqual(run.recorded.argv, ['--prefill', PROMPT])
    assert.equal(run.recorded.cwd, clone, 'the non-ASCII drive-letter cwd survives')
    assert.equal(run.dirLeft, false, 'the launcher removes its directory')
  })
}

await check('clipboard launcher keeps static arguments of a .cmd shim', async () => {
  const run = await runLauncher(() => buildWindowsClipboardLauncherScript({
    cwd: clone,
    title: 'Triage Desk: clipboard',
    bareCommand: '"' + shim + '" --label "two words" --yes',
  }))
  assert.ok(run.recorded, 'the agent ran: ' + run.result.stdout + run.result.stderr)
  assert.deepEqual(run.recorded.argv, ['--label', 'two words', '--yes'])
  assert.equal(run.recorded.cwd, clone)
  assert.equal(run.dirLeft, false)
})

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} windows checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('windows smoke OK')
}
