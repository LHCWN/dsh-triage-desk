/**
 * Dev smoke test for the host half: runs the plugin against a fake Cordis
 * context and the real `gh` CLI, then prints the snapshot served by the route
 * and the agent tool output.
 *
 * Requires a signed-in GitHub CLI (`gh auth login`) and network access.
 * Run with `npm run smoke:host`. Not shipped in the npm package.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)

function fakeSpawn(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), {
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  if (spec.signal !== undefined) {
    spec.signal.addEventListener('abort', () => child.kill('SIGTERM'))
  }
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))
  })
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
  }
}

const captured = { routes: new Map(), configRoute: null, tool: null, prompt: null }
const logger = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
}
const entry = { id: 'triage-desk', options: { id: 'triage-desk', name: 'dsh-triage-desk' } }
const configEditor = { entries: () => [entry], edit: async (_entry, change) => change({}, {}) }
const ctx = {
  logger: () => logger,
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register: (route) => {
      captured.routes.set(route.path, route)
      if (route.path.endsWith('/config')) captured.configRoute = route
      return () => {}
    },
  },
  connection: { requestRejection: () => undefined },
  subprocess: { resolveExecutable: async (command) => command, spawn: fakeSpawn },
  tools: {
    register: (definition) => {
      captured.tool = definition
      return () => {}
    },
  },
  systemPrompt: {
    section: (section) => {
      captured.prompt = section
      return () => {}
    },
  },
  fiber: { entry },
  get: (name) => (name === 'configEditor' ? configEditor : undefined),
}

apply(ctx, {})

const response = await captured.routes.get('/triage-desk/snapshot').resource(
  new Request('http://127.0.0.1/triage-desk/snapshot', { headers: { accept: 'application/json' } }),
)
const snapshot = await response.json()
console.log(`snapshot status: ${snapshot.status} (${snapshot.org || 'no org'})`)
console.log('counts:', JSON.stringify(snapshot.counts))
if (snapshot.warnings && snapshot.warnings.length) console.log('warnings:', JSON.stringify(snapshot.warnings))
if (snapshot.status === 'error') {
  console.error('snapshot failed:', JSON.stringify(snapshot.error))
  process.exitCode = 1
} else {
  for (const section of snapshot.sections) {
    if (section.items.length === 0) continue
    console.log(`\n[${section.id}] ${section.items.length}`)
    for (const item of section.items.slice(0, 5)) {
      const number = item.kind === 'branch' ? item.ref : '#' + item.number
      console.log(`  ${item.repo} ${number} — ${item.reason}`)
    }
  }
}

const toolResult = await captured.tool.execute({})
console.log('\nagent tool:\n' + toolResult.text.split('\n').slice(0, 6).join('\n'))
console.log('host smoke OK')
