/**
 * Fake interactive agent for dev/smoke-paste.mjs. It behaves like a TUI that
 * the paste wrapper drives: turns bracketed paste on, optionally shows a
 * folder-trust dialog that waits for Enter, then records the first bracketed
 * paste it receives.
 *
 * Usage: node fake-agent.mjs <plain|trust|busy> <result.json>
 * `busy` redraws a spinner every 100 ms forever, like Codex's start screen.
 * Exits 7 after recording the paste (the smoke checks the status is passed
 * through), 3 when nothing arrives in time.
 */
import { writeFileSync } from 'node:fs'

const [mode, resultFile] = process.argv.slice(2)
const events = []
let input = ''
let trusted = mode !== 'trust'

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdout.write('\x1b[?2004h')
if (mode === 'trust') {
  process.stdout.write('Accessing workspace\r\nDo you trust this folder?\r\n> Yes, I trust this folder\r\n')
} else {
  process.stdout.write('fake agent ready\r\n> ')
}
if (mode === 'busy') {
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  let frame = 0
  setInterval(() => process.stdout.write('\x1b7\x1b[1;1H' + frames[frame++ % frames.length] + '\x1b8'), 100)
}

const finish = (code) => {
  writeFileSync(resultFile, JSON.stringify({ events, input }))
  process.stdout.write('\x1b[?2004l')
  process.exit(code)
}

const timer = setTimeout(() => finish(3), 30_000)

process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
  if (!trusted) {
    const enter = input.search(/[\r\n]/)
    if (enter !== -1) {
      events.push({ type: 'trust-accepted', before: input.slice(0, enter) })
      input = input.slice(enter + 1)
      trusted = true
      process.stdout.write('\x1b[2J\x1b[Hfake agent ready\r\n> ')
    }
    return
  }
  const start = input.indexOf('\x1b[200~')
  const end = input.indexOf('\x1b[201~')
  if (start !== -1 && end > start) {
    events.push({ type: 'paste', text: input.slice(start + 6, end), before: input.slice(0, start) })
    process.stdout.write('[pasted]')
    clearTimeout(timer)
    setTimeout(() => finish(7), 200)
  }
})
