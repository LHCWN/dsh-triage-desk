/** Exercise the generated SSH launcher and retry in an isolated, offline SSH home. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSshScripts } from '../launcher.js'
import { pythonWithPty, removeOnExit } from './fixtures/platform.mjs'
import { assertUnsentPaste } from './fixtures/paste.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-ssh-test-'))
removeOnExit(root)
const windows = process.platform === 'win32'
const bin = path.join(root, 'bin')
const prompt = "Review this PR\n\n检查 'these' links · $HOME and `pwd`\nhttps://github.com/acme/widgets/pull/7"
await fs.mkdir(bin)
const writeTool = (name, script) => fs.writeFile(path.join(bin, name), script, { mode: 0o700 })
if (windows) {
  // Record the bytes sent by cmd's file redirection and simulate OpenSSH
  // returning a connection error before the interactive script can start.
  await writeTool('ssh.cmd', '@echo off\r\n"' + process.execPath + '" "%~dp0ssh.cjs" %*\r\n')
  await writeTool('ssh.cjs', `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n')
if (args.includes('-s')) fs.writeFileSync(process.env.UPLOAD, fs.readFileSync(0))
if (args[0] === '-tt' && process.env.DECLINE === 'yes') process.exit(255)
`)
} else {
  await writeTool('ssh', `#!/bin/sh
set -eu
mode=$1
while [ "$1" != -- ]; do shift; done
test "$2" = build-one || exit 2
cd "$REMOTE"
shift 2
if [ "$mode" = -tt ] && [ ! -e failed-once ]; then touch failed-once; exit 255; fi
exec "$@"
`)
  await writeTool('claude', '#!/bin/sh\npwd -P > "$RECORD.cwd"\nprintf "%s\\0" "$@" > "$RECORD"\n')
  await writeTool('codex', '#!/bin/sh\nexec node "$FAKE_AGENT" plain "$RECORD"\n')
}

async function checkLaunch(agent, decline = false) {
  const fixture = await fs.mkdtemp(path.join(root, agent + '-'))
  const remote = path.join(fixture, 'remote')
  await fs.mkdir(remote)
  const cwd = windows ? '/work/repo' : path.join(remote, "repo's checkout")
  if (!windows) await fs.mkdir(cwd)
  const dir = path.join(fixture, 'launch')
  await fs.mkdir(dir)
  const file = path.join(dir, windows ? 'launch.ps1' : 'launch.command')
  const { stage, local } = buildSshScripts({ alias: 'build-one', cwd, agent }, prompt, process.platform)
  await fs.writeFile(file, windows ? '\uFEFF' + local : local)
  await fs.writeFile(path.join(dir, 'stage.sh'), stage)
  const record = path.join(fixture, 'record')
  const uploadFile = path.join(fixture, 'upload')
  const psInvocation = decline ? ['-Command', "function Read-Host { 'n' }; & $env:LAUNCH_SCRIPT"] : ['-File', file]
  const result = spawnSync(windows ? 'powershell.exe' : '/bin/sh',
    windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...psInvocation] : [file], {
      encoding: 'utf8', timeout: 30_000, input: decline ? 'n\n' : 'y\n', cwd: root,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        REMOTE: remote, RECORD: record, UPLOAD: uploadFile, DECLINE: decline ? 'yes' : 'no', LAUNCH_SCRIPT: file,
        FAKE_AGENT: fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url)) },
    })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  if (windows) {
    const calls = (await fs.readFile(record, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const [upload, connect, cleanup] = calls
    assert.deepEqual(upload, ['-T', '--', 'build-one', 'sh', '-s'])
    assert.deepEqual(connect.slice(0, 4), ['-tt', '--', 'build-one', 'sh'])
    assert.equal(await fs.readFile(uploadFile, 'utf8'), stage)
    if (decline) assert.deepEqual(cleanup?.slice(-4), ['build-one', 'rm', '-f', connect[4]])
    else assert.equal(calls.length, 2)
  } else {
    assert.ok(result.stdout.includes('Retry the same draft?'), result.stdout)
    if (decline) {
      await assert.rejects(fs.access(record), { code: 'ENOENT' })
    } else if (agent === 'claude') {
      assert.equal(await fs.readFile(record, 'utf8'), '--prefill\0' + prompt + '\0')
      assert.equal((await fs.readFile(record + '.cwd', 'utf8')).trim(), await fs.realpath(cwd))
    } else {
      assertUnsentPaste(JSON.parse(await fs.readFile(record, 'utf8')), prompt)
    }
  }
  assert.deepEqual((await fs.readdir(remote)).filter((name) => name.startsWith('.triage-desk-')), [])
}

await checkLaunch('claude', true)
if (!windows) {
  if (pythonWithPty(['python3'])) await checkLaunch('codex')
  else console.log('SSH paste case SKIPPED (no python3 with pty on this machine)')
}
await checkLaunch('claude')
console.log('SSH smoke OK (' + process.platform + ')')
