/** Exercise the generated SSH launcher and retry in an isolated, offline SSH home. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSshScripts } from '../launcher.js'
import { removeOnExit } from './fixtures/platform.mjs'
import { assertUnsentPaste } from './fixtures/paste.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-ssh-test-'))
removeOnExit(root)
const windows = process.platform === 'win32'
const remote = path.join(root, 'remote')
const bin = path.join(root, 'bin')
const cwd = windows ? '/work/repo' : path.join(remote, "repo's checkout")
const prompt = "Review this PR\n\n检查 'these' links · $HOME and `pwd`\nhttps://github.com/acme/widgets/pull/7"
await fs.mkdir(remote)
await fs.mkdir(bin)
const writeTool = (name, script) => fs.writeFile(path.join(bin, name), script, { mode: 0o700 })
if (windows) {
  // The native process boundary checks PowerShell 5.1's UTF-8 pipeline for
  // the upload, then records the interactive invocation without a server.
  await writeTool('ssh.cmd', '@echo off\r\n"' + process.execPath + '" "%~dp0ssh.cjs" %*\r\n')
  await writeTool('ssh.cjs', `const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.RECORD, JSON.stringify(args) + '\\n')
if (args[0] === '-T') fs.writeFileSync(process.env.UPLOAD, fs.readFileSync(0))
`)
} else {
  await fs.mkdir(cwd)
  await writeTool('ssh', `#!/bin/sh
set -eu
test "$2" = -- && test "$3" = build-one || exit 2
cd "$REMOTE"
mode=$1
shift 3
if [ "$mode" = -tt ] && [ ! -e failed-once ]; then touch failed-once; exit 255; fi
exec "$@"
`)
  await writeTool('claude', '#!/bin/sh\npwd -P > "$RECORD.cwd"\nprintf "%s\\0" "$@" > "$RECORD"\n')
  await writeTool('codex', '#!/bin/sh\nexec node "$FAKE_AGENT" plain "$RECORD"\n')
}
for (const agent of windows ? ['claude'] : ['claude', 'codex']) {
  const dir = await fs.mkdtemp(path.join(root, 'launch-'))
  const file = path.join(dir, windows ? 'launch.ps1' : 'launch.command')
  const { stage, local } = buildSshScripts({ alias: 'build-one', cwd, agent }, prompt, process.platform)
  await fs.writeFile(file, windows ? '\uFEFF' + local : local)
  await fs.writeFile(path.join(dir, 'stage.sh'), stage)
  const record = path.join(root, 'record')
  const result = spawnSync(windows ? 'powershell.exe' : '/bin/sh',
    windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] : [file], {
      encoding: 'utf8', timeout: 30_000, input: !windows && agent === 'claude' ? 'y\n' : '', cwd: root,
      env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
        REMOTE: remote, RECORD: record, UPLOAD: path.join(root, 'upload'),
        FAKE_AGENT: fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url)) },
    })
  assert.equal(result.status, 0, result.error?.message || result.stderr)
  const data = await fs.readFile(record, 'utf8')
  if (windows) {
    const [upload, connect] = data.trim().split('\n').map((line) => JSON.parse(line))
    assert.deepEqual(upload, ['-T', '--', 'build-one', 'sh', '-s'])
    assert.deepEqual(connect.slice(0, 4), ['-tt', '--', 'build-one', 'sh'])
    assert.equal(await fs.readFile(path.join(root, 'upload'), 'utf8'), stage)
  } else if (agent === 'claude') {
    assert.ok(result.stdout.includes('Retry the same draft?'), result.stdout)
    assert.equal(data, '--prefill\0' + prompt + '\0')
    assert.equal((await fs.readFile(record + '.cwd', 'utf8')).trim(), await fs.realpath(cwd))
  } else {
    assertUnsentPaste(JSON.parse(data), prompt)
  }
  assert.deepEqual((await fs.readdir(remote)).filter((name) => name.startsWith('.triage-desk-')), [])
}
console.log('SSH smoke OK (' + process.platform + ')')
