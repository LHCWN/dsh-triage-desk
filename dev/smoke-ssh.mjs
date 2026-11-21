/** Exercise the generated SSH launcher and retry in an isolated, offline SSH home. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSshShellScripts, buildSshScripts, sshRepositoryScan, sshAgentProbe, configuredSshHosts } from '../launcher.js'
import { pythonWithPty, removeOnExit } from './fixtures/platform.mjs'
import { assertUnsentPaste } from './fixtures/paste.mjs'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-ssh-test-'))
removeOnExit(root)
const windows = process.platform === 'win32'
// A pre-commit hook exports GIT_DIR and other repository-local variables.
// All Git operations here, including those behind fake SSH, belong to fixtures.
const fixtureEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
fixtureEnv.GIT_CONFIG_NOSYSTEM = '1'
fixtureEnv.GIT_CONFIG_GLOBAL = path.join(root, 'gitconfig')
function git(args) {
  const result = spawnSync('git', args, { env: fixtureEnv, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

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
PATH="$REMOTE_BIN" exec "$@"
`)
  for (const tool of ['sh', 'rm', 'git', 'awk', 'sort', 'mv', 'mkdir', 'mktemp', 'python3', 'node', 'touch']) {
    const which = spawnSync('which', [tool], { encoding: 'utf8' })
    if (which.status === 0) await fs.symlink(which.stdout.trim().split('\n')[0], path.join(bin, tool))
  }
  // Some POSIX shells report this path from command -v even though exec fails.
  await fs.writeFile(path.join(bin, 'agy'), 'not executable', { mode: 0o600 })
  await writeTool('claude', '#!/bin/sh\npwd -P > "$RECORD.cwd"\nprintf "%s\\0" "$@" > "$RECORD"\nexit 130\n')
  await writeTool('codex', '#!/bin/sh\nexec node "$FAKE_AGENT" plain "$RECORD"\n')
}

// Run both halves in the same isolated SSH home across successive launches.
async function checkRemoteChoices() {
  const remote = await fs.mkdtemp(path.join(root, 'choices-'))
  const folders = [path.join(remote, 'missing'), path.join(remote, 'projects')]
  const first = path.join(folders[1], 'first')
  const copies = [first, path.join(first, 'worktrees', 'second'), path.join(folders[1], 'third')]
  const record = path.join(remote, 'record')
  await fs.mkdir(path.join(remote, '.ssh'))
  const sshConfig = path.join(remote, '.ssh', 'config')
  const aliases = [
    'Host unused github-work # aliases on this server',
    '  HostName = "github.com"',
    'Host _github-443',
    '  HostName ssh.github.com',
    'Host other-work',
    '  HostName gitlab.example',
    'Host other-work',
    '  HostName github.com',
    'Host ?hadow-*',
    '  HostName gitlab.example',
    'Host shadow-work',
    '  HostName github.com',
    'Host excluded-work !excluded-*',
    '  HostName github.com',
    'Host wildcard-*',
    '  HostName github.com',
  ].join('\n') + '\n'
  await fs.writeFile(sshConfig, aliases)
  for (const [folder, url] of [
    [copies[0], 'git@github-work:Acme/Widgets.git'],
    [copies[1], 'ssh://git@_github-443:443/Acme/Widgets.git'],
    [copies[2], 'git@github.com:Acme/Widgets.git'],
    [path.join(folders[1], 'other-host'), 'git@other-work:Acme/Widgets.git'],
    [path.join(folders[1], 'other-protocol'), 'https://github-work/Acme/Widgets.git'],
    [path.join(folders[1], 'shadowed'), 'git@shadow-work:Acme/Widgets.git'],
    [path.join(folders[1], 'excluded'), 'git@excluded-work:Acme/Widgets.git'],
    [path.join(folders[1], 'wildcard-only'), 'git@wildcard-work:Acme/Widgets.git'],
    [path.join(folders[1], 'different-case'), 'git@GitHub-Work:Acme/Widgets.git'],
    [path.join(remote, 'outside'), 'git@github.com:Acme/Widgets.git'],
  ]) {
    await fs.mkdir(folder, { recursive: true })
    git(['init', '-q', folder])
    git(['-C', folder, 'remote', 'add', 'origin', url])
  }
  const env = { ...fixtureEnv, HOME: remote, PATH: bin, RECORD: record, SHELL: path.join(bin, 'fixture-shell') }
  await writeTool('fixture-shell', '#!/bin/sh\ntest "$1" = -i || exit 1\npwd -P > "$RECORD.shell"\nexit 12\n')
  const server = { alias: 'build-one', agent: 'claude', folders, alternatives: ['codex'] }
  const run = (command, input = '') => {
    const result = spawnSync('/bin/sh', ['-c', command], { input, cwd: remote, env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr + '\n' + result.stdout)
    return result.stdout
  }
  const launch = (options, input, repo = 'acme/widgets') => {
    const { stage } = buildSshScripts({ ...server, ...options }, prompt, 'linux', repo)
    run(stage)
    return run('sh .triage-desk-*.sh', input)
  }
  const actual = await Promise.all(copies.map((folder) => fs.realpath(folder)))
  const shell = buildSshShellScripts(server, 'linux', 'acme/widgets')
  run(shell.stage)
  run('sh .triage-desk-*.sh', '1\nn\n')
  assert.equal((await fs.readFile(record + '.shell', 'utf8')).trimEnd(), actual[0])
  await fs.unlink(record + '.shell')
  await assert.rejects(fs.access(record), { code: 'ENOENT' })
  // Bash can export SHELLOPTS to child processes when it inherited the variable.
  await writeTool('check-shell-options', '#!/bin/bash\nprintf "%s" "$-" > "$RECORD.options"\n')
  run(shell.stage)
  const shellOptions = spawnSync('/bin/bash', ['-c', 'export SHELLOPTS; /bin/bash .triage-desk-*.sh'], {
    cwd: remote, env: { ...env, SHELL: path.join(bin, 'check-shell-options') }, input: '1\nn\n', encoding: 'utf8',
  })
  assert.equal(shellOptions.status, 0, shellOptions.stderr)
  assert.doesNotMatch(await fs.readFile(record + '.options', 'utf8'), /[eu]/)
  const scan = () => run(sshRepositoryScan({ ...server, folders: ['~/projects'] }).at(-1)).trimEnd().split('\n')
  assert.deepEqual(scan(), actual.map((dir) => 'acme/widgets\t' + dir))
  await fs.writeFile(sshConfig, 'HostName gitlab.example\n' + aliases)
  assert.deepEqual(scan(), ['acme/widgets\t' + actual[2]], 'global HostName shadows aliases')
  await fs.writeFile(sshConfig, aliases)
  // An agent installed only on the interactive bash PATH must be found by
  // both the settings check and the SSH launcher, using the same draft.
  const privateBin = path.join(remote, '.local', 'bin')
  await fs.mkdir(privateBin, { recursive: true })
  await fs.copyFile(path.join(bin, 'claude'), path.join(privateBin, 'pi'))
  await fs.writeFile(path.join(remote, '.bashrc'), 'export PATH="$HOME/.local/bin:$PATH"\n')
  if (process.platform === 'darwin') {
    const loginBin = path.join(remote, 'login-bin')
    await fs.mkdir(loginBin)
    await fs.copyFile(path.join(bin, 'claude'), path.join(loginBin, 'gemini'))
    await fs.writeFile(path.join(remote, '.zprofile'), 'export PATH="$HOME/login-bin:$PATH"\n')
    const probe = spawnSync('/bin/sh', ['-c', sshAgentProbe('build-one').at(-1)], {
      env: { ...env, SHELL: '/bin/zsh', ZDOTDIR: remote }, encoding: 'utf8',
    })
    assert.match(probe.stdout, /__td_agent__gemini/)
  }
  const originalShell = env.SHELL
  env.SHELL = '/bin/bash'
  assert.match(run(sshAgentProbe('build-one').at(-1)), /__td_agent__pi/)
  await fs.rename(path.join(bin, 'claude'), path.join(privateBin, 'claude'))
  try {
    assert.match(run(sshAgentProbe('build-one').at(-1)), /__td_agent__claude/)
    launch({}, '1\nn\n')
    assert.equal(await fs.readFile(record, 'utf8'), '--prefill\0' + prompt + '\0')
    await fs.rename(path.join(privateBin, 'claude'), path.join(privateBin, 'actual-claude'))
    await fs.appendFile(path.join(remote, '.bashrc'), 'alias claude=actual-claude\n')
    assert.match(run(sshAgentProbe('build-one').at(-1)), /__td_agent__claude/)
    await fs.unlink(record)
    launch({}, '1\nn\n')
    assert.equal(await fs.readFile(record, 'utf8'), '--prefill\0' + prompt + '\0')
  } finally {
    await fs.rename(path.join(privateBin, 'actual-claude'), path.join(bin, 'claude'))
    env.SHELL = originalShell
  }
  await fs.mkdir(path.join(remote, '.ssh', 'conf.d'))
  await fs.writeFile(path.join(remote, '.ssh', 'conf.d', 'build1.conf'), 'Host build-included\n')
  await fs.appendFile(sshConfig, 'Include conf.d/build[12].conf\n')
  const hosts = await configuredSshHosts(remote)
  assert.ok(hosts.includes('build-included'))
  assert.ok(hosts.includes('github-work') && !hosts.includes('wildcard-*'))
  const menu = launch({}, '2\ny\n')
  for (const dir of actual) assert.ok(menu.includes(dir))
  const opened = async () => (await fs.readFile(record + '.cwd', 'utf8')).trimEnd()
  assert.equal(await opened(), actual[1])
  assert.doesNotMatch(launch({}, ''), /Choose a working copy|Available agents/)
  assert.equal(await opened(), actual[1])
  assert.match(launch({ alias: 'build-two' }, '1\nn\n'), /Choose a working copy/)
  assert.equal(await opened(), actual[0])

  git(['-C', copies[1], 'remote', 'set-url', 'origin', 'git@github.com:else/widgets.git'])
  const staleMenu = launch({}, '2\ny\n')
  assert.match(staleMenu, /Choose a working copy/)
  assert.ok(staleMenu.includes(actual[0]) && staleMenu.includes(actual[2]))
  assert.ok(!staleMenu.includes(actual[1]))
  assert.equal(await opened(), actual[2], 'choose and remember a different valid checkout')

  git(['-C', copies[2], 'remote', 'remove', 'origin'])
  launch({}, '')
  assert.equal(await opened(), actual[0])
  assert.match(launch({}, '\n', 'missing/widgets'), /press Enter to continue/)
  assert.equal(await opened(), await fs.realpath(folders[1]))
  assert.match(launch({ folders: [folders[0]] }, '\n'), /press Enter to continue/)
  assert.equal(await opened(), await fs.realpath(remote))
  assert.match(launch({}, '', ''), /spans repositories/)
  assert.equal(await opened(), await fs.realpath(folders[1]))

  for (const alternatives of [[], ['codex', 'claude']]) {
    const output = launch({ agent: 'agy', alternatives }, alternatives.length ? '\ny\n' : 'y\n')
    assert.match(output, /Could not find agy in the launch environment on build-one/)
    assert.match(output, alternatives.length ? /Available agents: claude/ : /No configured alternative/)
    assert.match(output, /Opening a remote shell/)
    assert.equal((await fs.readFile(record + '.shell', 'utf8')).trimEnd(), actual[0])
    await fs.unlink(record + '.shell')
  }
  // Shadow Python with an interpreter that lacks pty. An installed paste-only
  // agent cannot accept this draft; the native alternative remains usable.
  const unavailable = path.join(remote, 'no-pty')
  await fs.mkdir(unavailable)
  await fs.writeFile(path.join(unavailable, 'python3'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  env.PATH = unavailable + path.delimiter + bin
  const noPaste = launch({ agent: 'agy', alternatives: ['codex', 'claude'] }, 'claude\n')
  assert.match(noPaste, /Available agents: claude\n/)
  assert.equal(await fs.readFile(record, 'utf8'), '--prefill\0' + prompt + '\0')
  const noPython = launch({ agent: 'codex' }, 'y\n')
  assert.match(noPython, /needs Python 3 with pty support/)
  assert.match(noPython, /Opening a remote shell/)

}

async function checkLaunch(agent, decline = false, alternative = false) {
  const fixture = await fs.mkdtemp(path.join(root, agent + '-'))
  const remote = path.join(fixture, 'remote')
  await fs.mkdir(remote)
  const cwd = windows ? '/work/repo' : path.join(remote, "repo's checkout")
  const checkout = path.join(cwd, 'renamed fork')
  if (!windows) {
    await fs.mkdir(checkout, { recursive: true })
    for (const [folder, name, url] of [
      [checkout, 'origin', 'git@github.com:other/widgets.git'],
      [checkout, 'upstream', 'https://github.com/ACME/Widgets.git'],
      [path.join(cwd, 'widgets'), 'origin', 'https://example.com/acme/widgets.git'],
    ]) {
      await fs.mkdir(folder, { recursive: true })
      git(['init', '-q', folder])
      git(['-C', folder, 'remote', 'add', name, url])
    }
  }
  const dir = path.join(fixture, 'launch')
  await fs.mkdir(dir)
  const file = path.join(dir, windows ? 'launch.ps1' : 'launch.command')
  const { stage, local } = buildSshScripts({ alias: 'build-one', cwd, agent, alternatives: alternative ? ['claude'] : [] }, prompt, process.platform, 'acme/widgets')
  await fs.writeFile(file, windows ? '\uFEFF' + local : local)
  await fs.writeFile(path.join(dir, 'stage.sh'), stage)
  const record = path.join(fixture, 'record')
  const uploadFile = path.join(fixture, 'upload')
  const psInvocation = decline ? ['-Command', "function Read-Host { 'n' }; & $env:LAUNCH_SCRIPT"] : ['-File', file]
  const result = spawnSync(windows ? 'powershell.exe' : '/bin/sh',
    windows ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...psInvocation] : [file], {
      encoding: 'utf8', timeout: 30_000, input: decline ? 'n\n' : alternative ? 'y\nclaude\n' : 'y\n', cwd: root,
      env: { ...fixtureEnv, PATH: bin + path.delimiter + process.env.PATH,
        HOME: remote, REMOTE_BIN: bin, REMOTE: remote, RECORD: record, UPLOAD: uploadFile, DECLINE: decline ? 'yes' : 'no', LAUNCH_SCRIPT: file,
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
    assert.equal(result.stdout.split('Retry the same draft?').length - 1, 1, result.stdout)
    if (decline) {
      await assert.rejects(fs.access(record), { code: 'ENOENT' })
    } else if (agent === 'claude' || alternative) {
      assert.equal(await fs.readFile(record, 'utf8'), '--prefill\0' + prompt + '\0')
      assert.equal((await fs.readFile(record + '.cwd', 'utf8')).trim(), await fs.realpath(checkout))
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
if (!windows) {
  await checkLaunch('agy', false, true)
  await checkRemoteChoices()
}
console.log('SSH smoke OK (' + process.platform + ')')
