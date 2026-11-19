/**
 * Dev smoke test for the paste wrapper on the platform it runs on: the Python
 * wrapper on macOS and Linux, the C# ConPTY host on Windows (CI runs all
 * three). A fake agent (dev/fixtures/fake-agent.mjs) turns bracketed paste on
 * and records what it receives, so the checks are:
 *   - the prompt arrives as one bracketed paste, byte for byte, with no Enter;
 *   - a folder-trust dialog holds the paste until the user presses Enter;
 *   - an agent that never stops redrawing still gets the paste;
 *   - the agent's exit status is passed through.
 *
 * Run with `npm run smoke:paste`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PASTE_WRAPPER_CS, PASTE_WRAPPER_PY, sanitizePastePrompt } from '../launcher.js'
import { assertUnsentPaste } from './fixtures/paste.mjs'
import { removeOnExit } from './fixtures/platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fakeAgent = path.join(here, 'fixtures', 'fake-agent.mjs')
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-paste-'))
removeOnExit(work)
const windows = process.platform === 'win32'

const PROMPT = sanitizePastePrompt(
  'Review https://github.com/acme/widgets/pull/288\r\nLine two — ünïcödé ✓\n\n\x1b[201~ cannot end the paste\tend',
)
assert.ok(!PROMPT.includes('\x1b'), 'ESC is removed before pasting')
assert.ok(!PROMPT.includes('\r'), 'CRLF becomes LF')

/**
 * A Python 3 with `pty`, or null. On macOS `/usr/bin/python3` is only an
 * installer stub until the Command Line Tools exist, and running it opens a
 * dialog, so it is skipped then (as the host does); every probe has a timeout.
 */
function python() {
  const stubOnly = process.platform === 'darwin' && spawnSync('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }).status !== 0
  for (const candidate of ['python3', 'python']) {
    const located = spawnSync('/bin/sh', ['-c', 'command -v "$0"', candidate], { encoding: 'utf8', timeout: 5000 }).stdout.trim()
    if (located === '' || (stubOnly && located === '/usr/bin/' + candidate)) continue
    const probe = spawnSync(located, ['-I', '-c', 'import pty, sys; print(sys.version_info[0])'], { encoding: 'utf8', timeout: 10_000 })
    if (probe.status === 0 && probe.stdout.trim() === '3') return located
  }
  return null
}

let wrapperCommand
if (windows) {
  const hostFile = path.join(work, 'paste-host.cs')
  await fs.writeFile(hostFile, PASTE_WRAPPER_CS, 'utf8')
  const runner = path.join(work, 'run.ps1')
  await fs.writeFile(
    runner,
    '﻿' + [
      'param([string]$PromptFile, [string]$Mode, [string]$Result)',
      "Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath '" + hostFile.replace(/'/g, "''") + "' -Encoding UTF8) -Language CSharp",
      '$command = \'"' + process.execPath + '" "' + fakeAgent + '" \' + $Mode + \' "\' + $Result + \'"\'',
      'exit [TriageDesk.PasteHost]::Run($command, $PromptFile, (Get-Location).ProviderPath)',
    ].join('\r\n'),
    'utf8',
  )
  wrapperCommand = (promptFile, mode, result) => [
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runner, promptFile, mode, result],
  ]
} else {
  const py = python()
  if (py === null) {
    console.log('paste smoke SKIPPED (no Python 3 with pty on this machine)')
    process.exit(0)
  }
  const wrapperFile = path.join(work, 'paste-wrapper.py')
  await fs.writeFile(wrapperFile, PASTE_WRAPPER_PY, 'utf8')
  wrapperCommand = (promptFile, mode, result) => [py, ['-I', wrapperFile, promptFile, process.execPath, fakeAgent, mode, result]]
}

/** Runs the wrapper around the fake agent; `onOutput` sees the accumulated screen text. */
function runWrapper(mode, onOutput = () => {}) {
  return new Promise((resolve, reject) => {
    const promptFile = path.join(work, mode + '-prompt.txt')
    const result = path.join(work, mode + '-result.json')
    fs.writeFile(promptFile, PROMPT, 'utf8').then(() => {
      const [command, args] = wrapperCommand(promptFile, mode, result)
      const child = spawn(command, args, { cwd: work, stdio: ['pipe', 'pipe', 'pipe'] })
      let output = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error(mode + ': timed out\n' + output + stderr)) }, 60_000)
      child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); onOutput(output, child) })
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
      child.on('error', reject)
      child.on('close', async (code) => {
        clearTimeout(timer)
        try {
          const recorded = JSON.parse(await fs.readFile(result, 'utf8'))
          const promptLeft = await fs.stat(promptFile).then(() => true, () => false)
          resolve({ code, output, stderr, recorded, promptLeft })
        } catch (error) {
          reject(new Error(mode + ': no result (exit ' + code + ')\n' + output + '\n' + stderr + '\n' + error.message))
        }
      })
    }, reject)
  })
}

const started = Date.now()
const plain = await runWrapper('plain')
assertUnsentPaste(plain.recorded, PROMPT, plain.stderr)
assert.equal(plain.code, 7, 'the agent exit status is passed through')
assert.equal(plain.promptLeft, false, 'the prompt file is removed')
console.log('ok   plain: one bracketed paste, unsent, exit status kept (' + (Date.now() - started) + ' ms)')

const busyStarted = Date.now()
const busy = await runWrapper('busy')
const busyPaste = busy.recorded.events.find((event) => event.type === 'paste')
assert.ok(busyPaste, 'a never-quiet agent still gets the paste: ' + JSON.stringify(busy.recorded))
assert.equal(busyPaste.text, PROMPT)
assert.ok(Date.now() - busyStarted < 20_000, 'the settle timeout, not the deadline, delivered it')
console.log('ok   busy screen: pasted after the settle time (' + (Date.now() - busyStarted) + ' ms)')

let pressedAt = null
const trust = await runWrapper('trust', (output, child) => {
  if (pressedAt === null && /trust this folder/i.test(output)) {
    // A user reading the dialog: wait well past the quiet period, then Enter.
    pressedAt = -1
    setTimeout(() => { pressedAt = Date.now(); child.stdin.write('\r') }, 2000)
  }
})
const accepted = trust.recorded.events.findIndex((event) => event.type === 'trust-accepted')
const trustPaste = trust.recorded.events.findIndex((event) => event.type === 'paste')
assert.notEqual(accepted, -1, 'the trust dialog saw the Enter: ' + JSON.stringify(trust.recorded))
assert.equal(trust.recorded.events[accepted].before, '', 'no paste went into the trust dialog')
assert.ok(trustPaste > accepted, 'the paste came after the dialog was accepted')
assert.equal(trust.recorded.events[trustPaste].text, PROMPT)
assert.equal(trust.code, 7)
console.log('ok   trust dialog: paste held until Enter, then delivered')

// A user who accepts the dialog before the wrapper has looked at the screen:
// the Enter must not leave the dismissed dialog holding the paste.
let answered = false
const fast = await runWrapper('trust', (output, child) => {
  if (!answered && /trust this folder/i.test(output)) {
    answered = true
    child.stdin.write('\r')
  }
})
const fastAccepted = fast.recorded.events.findIndex((event) => event.type === 'trust-accepted')
const fastPaste = fast.recorded.events.findIndex((event) => event.type === 'paste')
assert.ok(fastAccepted !== -1 && fastPaste > fastAccepted, 'an early Enter still lets the paste through: ' + JSON.stringify(fast.recorded))
assert.equal(fast.recorded.events[fastPaste].text, PROMPT)
console.log('ok   trust dialog accepted at once: the paste still arrives')

console.log('paste smoke OK (' + (windows ? 'ConPTY host' : 'Python pty wrapper') + ', ' + process.platform + ')')
