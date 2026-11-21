/**
 * Dev smoke test for the host routes added by the terminal launcher: config
 * GET/POST, clone scanning, launch success and failure paths, launch scenarios,
 * and the `triage_desk` launch action. Uses a fake Cordis context and a fake
 * subprocess layer, so it never opens Terminal and never touches GitHub.
 *
 * Run with `npm run smoke:routes`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { withHome } from './fixtures/platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
// The fake subprocess layer answers macOS commands (Terminal, osascript, open),
// so the host must see darwin on every runner, including Linux CI. Set before
// the host modules are imported: `apply` captures the platform once.
Object.defineProperty(process, 'platform', { value: 'darwin' })
const { apply } = await import(pathToFileURL(path.join(here, '..', 'index.js')).href)
const {
  SCENARIO_SECTION_IDS,
  SCENARIO_SECTION_LABELS,
  SCENARIO_REASON_LABELS,
  MAX_SCENARIO_TEMPLATE,
  MAX_SCENARIOS,
  AGENTS_VERSION,
  defaultAgentCommand,
  defaultScenarios,
  normalizeLauncherConfig,
  openTerminalPlan,
  PASTE_WRAPPER_PY,
} = await import(pathToFileURL(path.join(here, '..', 'launcher.js')).href)

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-routes-'))
const cloneDir = path.join(fixture, 'Playground', 'widgets')
const workspaceDir = path.join(fixture, 'workspace')
await fs.mkdir(path.join(cloneDir, '.git'), { recursive: true })
await fs.mkdir(workspaceDir, { recursive: true })
await fs.writeFile(
  path.join(cloneDir, '.git', 'config'),
  '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n',
)

const PR_URL = 'https://github.com/acme/widgets/pull/288'
const PR_URL_2 = 'https://github.com/acme/widgets/pull/7'
const OTHER_REPO_URL = 'https://github.com/acme/api/pull/7'
const OTHER_REPO_URL_2 = 'https://github.com/acme/api/pull/9'
const captured = {
  pythonOk: false,
  routes: new Map(),
  tool: null,
  prompt: null,
  fence: null,
  edits: [],
  opens: [],
  gitCalls: [],
  gitRemotes: 'remote.origin.url git@github.com:acme/widgets.git\n',
  shellCalls: [],
  launchFiles: [],
  clipboard: null,
  pickChoice: null,
  ghAuthenticated: false,
  ghMissing: false,
}

const claude = { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' }
const codex = { id: 'codex', label: 'Codex', command: 'codex {prompt}' }

const customScenarios = [
  {
    id: 'repeated-links',
    label: 'Repeated links',
    scope: 'section',
    sections: ['review'],
    prompt: 'Review the following PRs.\n' + '{links}\n'.repeat(420),
    agent: 'default',
    enabled: true,
  },
  {
    id: 'custom-review',
    label: 'Custom review',
    scope: 'item',
    sections: SCENARIO_SECTION_IDS,
    prompt: 'Custom review prompt for {url}',
    agent: 'default',
    enabled: true,
  },
  {
    id: 'ask-review',
    label: 'Ask review',
    scope: 'item',
    sections: ['review'],
    prompt: 'Ask for review of {url}',
    agent: 'default',
    enabled: true,
  },
  {
    id: 'codex-review',
    label: 'Codex review',
    scope: 'item',
    sections: ['review'],
    prompt: 'Review {url} with codex',
    agent: 'codex',
    enabled: true,
  },
]

function fakeHandle(exitCode, stdout, stderr) {
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
    terminate() {},
  }
}

function fakeSpawn(spec) {
  const argv = spec.argv
  if (argv[0] === 'ssh') {
    assert.deepEqual(argv.slice(0, -1), ['ssh', '-T', '-o', 'BatchMode=yes', '--', 'builder'])
    assert.ok(argv.at(-1).includes('/work/remote'))
    return fakeHandle(0, 'acme/widgets\t/work/remote/fork\n', '')
  }
  if (argv[0] === '/usr/bin/pbcopy') {
    captured.clipboard = spec.stdio && spec.stdio.stdin ? spec.stdio.stdin.data : null
    return fakeHandle(0, '', '')
  }
  if (argv[0] === '/usr/bin/open' || argv[0] === 'open') {
    captured.opens.push(argv)
    captured.launchFiles.push(argv[argv.length - 1])
    return fakeHandle(0, '', '')
  }
  if (argv[0] === 'osascript') {
    // The fake host cannot drive Terminal AppleScript: force the window fallback.
    return fakeHandle(1, '', 'osascript unavailable in the smoke test')
  }
  if (argv[0] === 'gh' || argv[0].endsWith('/gh')) {
    if (argv[1] === 'auth' && argv[2] === 'status') {
      if (captured.ghAuthenticated) {
        return fakeHandle(
          0,
          "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Token scopes: 'repo', 'read:org'\n",
          '',
        )
      }
      return fakeHandle(1, '', 'You are not logged into any GitHub hosts.')
    }
    return fakeHandle(0, '', '')
  }
  if (argv[0].endsWith('/python3') && argv[1] === '-I') {
    // The paste-support probe: a working Python 3 prints its major version.
    return captured.pythonOk ? fakeHandle(0, '3\n', '') : fakeHandle(1, '', 'no python')
  }
  if (argv[0] === '/usr/bin/git' || argv[0] === 'git') {
    captured.gitCalls.push(argv)
    if (argv.includes('--get-regexp')) return fakeHandle(0, captured.gitRemotes, '')
    return fakeHandle(0, 'feature-x\n', '')
  }
  if (argv[0] === '/bin/zsh' || argv[0] === '/bin/bash' || argv[0] === '/bin/sh' || argv[1] === '-lc') {
    captured.shellCalls.push(argv)
    const executables = argv.slice(4)
    let output = ''
    for (const executable of executables) {
      // `captured.installed`, when set, lists the only agent executables found.
      const missing = executable === 'missing-agent' || (captured.installed && !captured.installed.includes(executable))
      const located = missing ? '' : '/opt/homebrew/bin/' + executable
      output += ['__td__', executable, located, located].join('\t') + '\n'
    }
    return fakeHandle(0, output, '')
  }
  return fakeHandle(1, '', 'unexpected command: ' + argv.join(' '))
}

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
}
const entry = { id: 'triage-desk', options: { id: 'triage-desk', name: 'dsh-triage-desk' } }
const configEditor = {
  entries: () => [entry],
  edit: async (_entry, change) => {
    captured.edits.push(change({}, {}))
  },
}
const fakeResponse = () => ({
  statusCode: 0,
  headers: {},
  body: '',
  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value
  },
  end(text) {
    this.body = text === undefined ? '' : String(text)
  },
})
const ctx = {
  logger: () => logger,
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  // Event listeners; the host only listens to its own fiber's `internal/update`.
  on: () => () => {},
  webServer: {
    register: (route) => {
      captured.routes.set(route.path, route)
      return () => {}
    },
  },
  connection: { requestRejection: () => captured.fence || undefined },
  subprocess: {
    resolveExecutable: async (command) => {
      if (captured.ghMissing && /(^|\/)gh$/.test(command)) throw new Error('not found')
      if (command === 'gh' || /(^|\/)gh$/.test(command)) return '/opt/homebrew/bin/gh'
      return command
    },
    spawn: fakeSpawn,
  },
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
  get: (name) => {
    if (name === 'configEditor') return configEditor
    if (name === 'workspaceRegistry') return { list: () => [{ path: workspaceDir }] }
    if (name === 'directoryPickerController') return { pick: async () => captured.pickChoice }
    return undefined
  },
}

apply(ctx, {
  sshServers: [{ alias: 'builder', agent: 'claude', cwd: '/work/remote' }],
  agents: [
    claude,
    codex,
    { id: 'missing', label: 'Missing Agent', command: 'missing-agent {prompt}' },
  ],
  defaultAgent: 'claude',
  cloneDirs: [path.join(fixture, 'Playground')],
  scenarios: [...defaultScenarios(), ...customScenarios],
  defaultScenario: 'link',
})

async function callHandler(routePath, method, body, routes = captured.routes) {
  const route = routes.get(routePath.split('?')[0])
  if (!route || typeof route.handler !== 'function') throw new Error('missing route ' + routePath)
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  req.url = routePath
  req.headers = {}
  const res = fakeResponse()
  await route.handler(req, res)
  return res
}

async function json(res) {
  return JSON.parse(res.body)
}

const checks = []

async function recordAsync(name, callback) {
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
 * Removes the per-launch temp directories. Only `triage-desk-*` directories
 * under the system temp dir are touched: `open -a Terminal` (the activation
 * nudge) also lands in `launchFiles`, and its "file" is just `Terminal`.
 */
async function cleanupLaunches() {
  const tmp = await fs.realpath(os.tmpdir())
  for (const file of captured.launchFiles.splice(0)) {
    const dir = path.dirname(file)
    const real = await fs.realpath(dir).catch(() => '')
    if (!path.isAbsolute(dir) || !path.basename(dir).startsWith('triage-desk-')) continue
    if (real === '' || path.dirname(real) !== tmp) continue
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

await recordAsync('config GET exposes launcher settings, scenarios, and detection', async () => {
  const res = await callHandler('/triage-desk/config', 'GET')
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.config.promptTemplate, undefined)
  assert.equal(payload.config.defaultAgent, 'claude')
  assert.equal(payload.config.defaultScenario, 'link')
  assert.equal(payload.config.agents.length, 3)
  assert.equal(payload.config.agents[0].draftFlag, '--prefill')
  assert.equal(payload.config.detectedAgents.claude.available, true)
  assert.equal(payload.config.detectedAgents.missing.available, false)
  assert.equal(payload.config.detectedAgents.claude.executable, 'claude', 'detection reports the parsed executable')
  assert.equal(payload.config.detectedAgents.missing.executable, 'missing-agent')
  assert.deepEqual(payload.config.labels, { sections: SCENARIO_SECTION_LABELS, reasons: SCENARIO_REASON_LABELS })
  assert.equal(payload.config.labels.sections.review, SCENARIO_SECTION_LABELS.review)
  assert.ok(Array.isArray(payload.config.cloneDirsDefault))
  assert.equal(payload.config.editable, true)
  assert.equal(payload.config.scenarios.length, defaultScenarios().length + customScenarios.length)
  const link = payload.config.scenarios[0]
  assert.equal(link.id, 'link')
  assert.equal(link.label, '')
  assert.equal(link.scope, 'item')
  assert.equal(link.prompt, '{url}')
  assert.equal(link.enabled, true)
  assert.deepEqual(link.sections, SCENARIO_SECTION_IDS)
  const custom = payload.config.scenarios.find((scenario) => scenario.id === 'custom-review')
  assert.equal(custom.label, 'Custom review')
  assert.equal(custom.agent, 'default')
  assert.equal(payload.config.supportsPrompt, true)
  assert.equal(payload.config.supportsAgentDiscovery, true)
  assert.ok(Array.isArray(payload.config.scenarioDefaults))
  assert.equal(payload.config.scenarioDefaults.length, defaultScenarios().length)
  assert.equal(payload.config.scenarioDefaults[0].id, 'link')
  assert.equal(payload.config.scenarioDefaults[0].label, '')
  assert.deepEqual(payload.limits.refreshSeconds, { min: 15, max: 3600, default: 1200 })
  assert.equal(payload.limits.scenarios, MAX_SCENARIOS)
  assert.equal(payload.limits.scenarioTemplate, MAX_SCENARIO_TEMPLATE)
  assert.equal(payload.limits.prompt, 16_000)
})

await recordAsync('repository discovery uses only the selected saved destination', async () => {
  const scan = (alias) => callHandler('/triage-desk/clones?sshAlias=' + alias, 'GET')
  const config = (await json(await callHandler('/triage-desk/config', 'GET'))).config
  assert.equal(config.supportsSshRepositoryFolders, true)
  assert.deepEqual(config.sshServers[0].folders, ['/work/remote'])
  assert.deepEqual((await json(await scan('builder'))).clones, [{ repo: 'acme/widgets', path: '/work/remote/fork' }])
  assert.equal((await json(await scan('unknown'))).error.code, 'bad-destination')
})

await recordAsync('SSH launches resolve only saved destinations and use the remote folder and agent', async () => {
  const body = { url: PR_URL, scenario: 'custom-review', sshAlias: 'builder' }
  const result = await json(await callHandler('/triage-desk/launch', 'POST', body))
  assert.equal(result.cwdMode, 'ssh')
  assert.equal(result.cwd, null, 'the SSH terminal resolves the actual directory')
  assert.equal(result.agent.id, 'claude')
  const unknown = await json(await callHandler('/triage-desk/launch', 'POST', { ...body, sshAlias: 'unknown' }))
  assert.equal(unknown.error.code, 'bad-destination')
  await cleanupLaunches()
})

await recordAsync('launch without a scenario uses the link scenario', async () => {
  captured.opens.length = 0
  const res = await callHandler('/triage-desk/launch', 'POST', {
    url: PR_URL,
    agent: 'claude',
    number: 288,
    title: 'Add feature',
    headRefName: 'feature-x',
    kind: 'pull',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.agent.id, 'claude')
  assert.equal(payload.cwd, cloneDir)
  assert.ok(captured.opens.length >= 1)
  assert.equal(payload.mode, 'draft')
  assert.deepEqual(payload.scenario, { id: 'link', label: 'Just the link' })
  assert.equal(payload.count, 1)
  assert.equal(payload.trimmed, null)
  assert.equal(payload.cwdMode, 'clone')
  assert.equal(payload.cloneMissing, false)
  assert.equal(payload.repo, 'acme/widgets')
  assert.ok(captured.clipboard.includes(PR_URL))
  const argv = captured.opens.find((entry) => entry.length === 4)
  assert.equal(argv[0], '/usr/bin/open')
  assert.equal(argv[1], '-a')
  assert.equal(argv[2], 'Terminal')
  const launcherFile = argv[3]
  const script = await fs.readFile(launcherFile, 'utf8')
  assert.ok(script.includes('cd -- ' + "'" + cloneDir + "'"))
  assert.ok(script.includes("claude --dangerously-skip-permissions --prefill " + "'" + PR_URL + "'"))
  assert.ok(!script.includes('ZDOTDIR'))
  await cleanupLaunches()
})

await recordAsync('agents without a native draft flag fall back to the clipboard', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', {
    url: PR_URL,
    agent: 'codex',
    number: 288,
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.mode, 'clipboard')
  assert.equal(captured.clipboard, PR_URL)
  const argv = captured.opens.find((entry) => entry.length === 4)
  const script = await fs.readFile(argv[3], 'utf8')
  assert.ok(script.includes('\n/opt/homebrew/bin/codex --dangerously-bypass-approvals-and-sandbox\n'), 'the detected binary is launched by path')
  assert.ok(!script.includes(PR_URL))
  await cleanupLaunches()
})

await recordAsync('launch with a known scenario builds its prompt', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'review-pr' })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(payload.scenario, { id: 'review-pr', label: 'Review this PR' })
  assert.equal(payload.agent.id, 'claude')
  assert.equal(payload.count, 1)
  assert.equal(payload.trimmed, null)
  assert.ok(captured.clipboard.startsWith('Review pull request ' + PR_URL))
  assert.ok(captured.clipboard.includes('repos/acme/widgets/pulls/288/reviews'), captured.clipboard)
  assert.ok(!captured.clipboard.includes('Items:'))
  await cleanupLaunches()
})

await recordAsync('launch with a custom scenario and an explicit agent', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', {
    url: PR_URL,
    scenario: 'custom-review',
    agent: 'codex',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.mode, 'clipboard')
  assert.equal(payload.agent.id, 'codex')
  assert.deepEqual(payload.scenario, { id: 'custom-review', label: 'Custom review' })
  assert.ok(captured.clipboard.startsWith('Custom review prompt for ' + PR_URL))
  await cleanupLaunches()
})

await recordAsync('a scenario agent is used when no agent is passed', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'codex-review' })
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.agent.id, 'codex')
  assert.ok(captured.clipboard.startsWith('Review ' + PR_URL + ' with codex'))
  await cleanupLaunches()
})

await recordAsync('prompt route renders item and section prompts without launching', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const item = await callHandler('/triage-desk/prompt', 'POST', { url: PR_URL, scenario: 'custom-review' })
  assert.equal(item.statusCode, 200)
  const itemPayload = await json(item)
  assert.equal(itemPayload.count, 1)
  assert.equal(itemPayload.scenario.id, 'custom-review')
  assert.ok(itemPayload.prompt.startsWith('Custom review prompt for ' + PR_URL))
  assert.equal(captured.opens.length, 0, 'a prompt must not open a terminal')
  assert.equal(captured.clipboard, null, 'a prompt must not touch the clipboard')
  const section = await callHandler('/triage-desk/prompt', 'POST', {
    scenario: 'review-all',
    section: 'review',
    urls: [PR_URL],
  })
  assert.equal(section.statusCode, 200)
  const sectionPayload = await json(section)
  assert.equal(sectionPayload.count, 1)
  assert.ok(sectionPayload.prompt.includes('Review each pull request below'))
  assert.ok(sectionPayload.prompt.includes(PR_URL))
  const badUrl = await callHandler('/triage-desk/prompt', 'POST', {
    url: 'https://example.com/x',
    scenario: 'custom-review',
  })
  assert.equal(badUrl.statusCode, 400)
  assert.equal((await json(badUrl)).error.code, 'bad-url')
  assert.equal(captured.opens.length, 0)
})

await recordAsync('an oversized section prompt fails before draft delivery or terminal launch', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  for (const route of ['/triage-desk/prompt', '/triage-desk/launch']) {
    const res = await callHandler(route, 'POST', { scenario: 'repeated-links', section: 'review', urls: [PR_URL] })
    assert.equal(res.statusCode, 400)
    const { error } = await json(res)
    assert.equal(error.code, 'bad-prompt')
    assert.match(error.message, /no items fit/i)
  }
  assert.equal(captured.opens.length, 0)
  assert.equal(captured.clipboard, null)
})

await recordAsync('copy and launch render the same ordered and size-limited group', async () => {
  const urls = Array.from({ length: 340 }, (_, i) => 'https://github.com/acme/widgets/pull/' + (340 - i))
  const request = { scenario: 'review-all', section: 'review', urls }
  const copy = await json(await callHandler('/triage-desk/prompt', 'POST', request))
  const launch = await json(await callHandler('/triage-desk/launch', 'POST', { ...request, agent: 'codex' }))
  assert.equal(copy.trimmed.total, urls.length)
  assert.ok(copy.trimmed.shown < urls.length)
  assert.deepEqual(launch.trimmed, copy.trimmed)
  assert.equal(copy.prompt, captured.clipboard)
  assert.ok(copy.prompt.indexOf(urls[0]) >= 0 && copy.prompt.indexOf(urls[0]) < copy.prompt.indexOf(urls[1]))
  await cleanupLaunches()
})

await recordAsync('an unknown scenario is rejected with bad-scenario', async () => {
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'no-such-scenario' })
  assert.equal(res.statusCode, 400)
  const payload = await json(res)
  assert.equal(payload.error.code, 'bad-scenario')
  assert.ok(payload.error.message.includes('no-such-scenario'))
})

await recordAsync('missing clone opens the workspace instead', async () => {
  captured.opens.length = 0
  const res = await callHandler('/triage-desk/launch', 'POST', {
    url: OTHER_REPO_URL,
    agent: 'claude',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.cloneMissing, true)
  assert.equal(payload.cwd, workspaceDir)
  assert.equal(payload.cwdMode, 'workspace')
  const argv = captured.opens.find((entry) => entry.length === 4)
  const script = await fs.readFile(argv[3], 'utf8')
  assert.ok(script.includes('cd -- ' + "'" + workspaceDir + "'"))
  await cleanupLaunches()
})

await recordAsync('section launch over one repository uses the clone', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', {
    scenario: 'review-all',
    section: 'review',
    urls: [PR_URL, PR_URL_2, PR_URL, 'https://example.com/not-github'],
    agent: 'codex',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.scenario, { id: 'review-all', label: 'Review everything awaiting me' })
  assert.equal(payload.count, 2)
  assert.equal(payload.repo, 'acme/widgets')
  assert.equal(payload.cwd, cloneDir)
  assert.equal(payload.cloneMissing, false)
  assert.equal(payload.cwdMode, 'clone')
  assert.equal(payload.trimmed, null)
  assert.equal(payload.agent.id, 'codex')
  assert.ok(captured.clipboard.startsWith('Review each pull request below'))
  assert.ok(captured.clipboard.includes('Items: 2 · sections: awaiting my review'))
  assert.ok(captured.clipboard.includes(PR_URL))
  assert.ok(captured.clipboard.includes(PR_URL_2))
  assert.ok(!captured.clipboard.includes('example.com'))
  const argv = captured.opens.find((entry) => entry.length === 4)
  const script = await fs.readFile(argv[3], 'utf8')
  assert.ok(script.includes('cd -- ' + "'" + cloneDir + "'"))
  assert.ok(script.includes('Review everything awaiting me (2)'))
  await cleanupLaunches()
})

await recordAsync('section launch over two repositories opens the workspace', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', {
    scenario: 'review-all',
    section: 'review',
    urls: [PR_URL, OTHER_REPO_URL],
    agent: 'codex',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.count, 2)
  assert.equal(payload.repo, '')
  assert.equal(payload.cwd, workspaceDir)
  assert.equal(payload.cloneMissing, false)
  assert.equal(payload.cwdMode, 'workspace')
  assert.ok(captured.clipboard.includes('Items: 2 · sections: awaiting my review'))
  assert.ok(captured.clipboard.includes(PR_URL))
  assert.ok(captured.clipboard.includes(OTHER_REPO_URL))
  const argv = captured.opens.find((entry) => entry.length === 4)
  const script = await fs.readFile(argv[3], 'utf8')
  assert.ok(script.includes('cd -- ' + "'" + workspaceDir + "'"))
  await cleanupLaunches()
})

await recordAsync('section launch over one missing clone falls back to the workspace', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', {
    scenario: 'review-all',
    section: 'review',
    urls: [OTHER_REPO_URL, OTHER_REPO_URL_2],
    agent: 'codex',
  })
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.equal(payload.count, 2)
  assert.equal(payload.repo, 'acme/api')
  assert.equal(payload.cwd, workspaceDir)
  assert.equal(payload.cloneMissing, true)
  assert.equal(payload.cwdMode, 'workspace')
  await cleanupLaunches()
})

await recordAsync('section launch payload errors are classified', async () => {
  const noSection = await callHandler('/triage-desk/launch', 'POST', { scenario: 'review-all', urls: [PR_URL] })
  assert.equal(noSection.statusCode, 400)
  assert.equal((await json(noSection)).error.code, 'bad-scenario')
  const noUrls = await callHandler('/triage-desk/launch', 'POST', { scenario: 'review-all', section: 'review' })
  assert.equal(noUrls.statusCode, 400)
  assert.equal((await json(noUrls)).error.code, 'bad-scenario')
  const badUrls = await callHandler('/triage-desk/launch', 'POST', {
    scenario: 'review-all',
    section: 'review',
    urls: ['https://example.com/x'],
  })
  assert.equal(badUrls.statusCode, 400)
  assert.equal((await json(badUrls)).error.code, 'bad-url')
  const sectionScenarioAsItem = await callHandler('/triage-desk/launch', 'POST', {
    url: PR_URL,
    scenario: 'review-all',
  })
  assert.equal(sectionScenarioAsItem.statusCode, 400)
  assert.equal((await json(sectionScenarioAsItem)).error.code, 'bad-scenario')
})

await recordAsync('unknown URL, unknown agent, and a missing binary are rejected', async () => {
  const badUrl = await json(await callHandler('/triage-desk/launch', 'POST', { url: 'https://example.com/x', agent: 'claude' }))
  assert.equal(badUrl.error.code, 'bad-url')
  const unknown = await json(await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'nope' }))
  assert.equal(unknown.error.code, 'unknown-agent')
  const missing = await json(await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'missing' }))
  assert.equal(missing.error.code, 'agent-missing')
})

await recordAsync('agent discovery finds installed CLIs in the login shell', async () => {
  const res = await callHandler('/triage-desk/agents/find', 'POST', {})
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.ok, true)
  const ids = payload.found.map((entry) => entry.id)
  assert.ok(ids.includes('claude'), 'the built-in agents are discoverable')
  assert.ok(ids.includes('aider'), 'extra known CLIs are discoverable')
  assert.equal(payload.found.find((entry) => entry.id === 'claude').path, '/opt/homebrew/bin/claude')
  assert.ok(payload.checked >= 12, 'the whole catalog is checked')
  assert.equal(payload.found.find((entry) => entry.id === 'claude').executable, 'claude', 'entries carry the executable')
})

await recordAsync('agent discovery skips executables of the commands the client already has', async () => {
  const find = async (body) => {
    const res = await callHandler('/triage-desk/agents/find', 'POST', body)
    assert.equal(res.statusCode, 200, res.body)
    return json(res)
  }
  const all = await find(undefined)
  const allIds = all.found.map((entry) => entry.id)
  assert.ok(allIds.includes('claude') && allIds.includes('codex'), 'no body behaves as before')
  const filtered = await find({ commands: ['claude --model opus {prompt}', '/elsewhere/codex {prompt}', 42] })
  const ids = filtered.found.map((entry) => entry.id)
  assert.ok(!ids.includes('claude'), 'a configured executable is excluded')
  assert.ok(ids.includes('codex'), 'only equal executables are excluded, not equal basenames')
  assert.equal(filtered.checked, all.checked, 'the whole catalog is still checked')
  for (const entry of filtered.found) assert.equal(typeof entry.executable, 'string')
  for (const invalid of [{ commands: 'claude {prompt}' }, { commands: Array(51).fill('claude {prompt}') }, []]) {
    const ignored = await find(invalid)
    assert.deepEqual(ignored.found.map((entry) => entry.id), allIds, 'invalid input is ignored: ' + JSON.stringify(invalid).slice(0, 40))
  }
  const longCommand = 'claude ' + 'x'.repeat(300) + ' {prompt}'
  const tooLong = await find({ commands: [longCommand] })
  assert.ok(tooLong.found.some((entry) => entry.id === 'claude'), 'an over-long command is ignored')
  const shellCallsBefore = captured.shellCalls.length
  const oversized = await callHandler('/triage-desk/agents/find', 'POST', { commands: ['x'.repeat(70 * 1024)] })
  assert.equal(oversized.statusCode, 400, 'an oversized body is rejected like on other routes')
  assert.equal(JSON.parse(oversized.body).error.code, 'bad-request')
  assert.equal(captured.shellCalls.length, shellCallsBefore, 'a rejected body does not start the login-shell scan')
})

await recordAsync('clone scan route lists the configured directories', async () => {
  const res = await callHandler('/triage-desk/clones', 'GET')
  const payload = await json(res)
  assert.equal(res.statusCode, 200)
  assert.ok(payload.clones.some((clone) => clone.repo === 'acme/widgets' && clone.path === cloneDir))
  assert.equal(payload.dirs[0].exists, true)
})

const scenarioBase = () => [
  ...defaultScenarios(),
  { id: 'custom-test', label: 'Custom test', scope: 'item', sections: ['review'], prompt: 'Do {url}', agent: 'default', enabled: true },
]

await recordAsync('config POST rejects invalid scenarios', async () => {
  const linkDisabled = defaultScenarios().map((scenario) => (scenario.id === 'link' ? { ...scenario, enabled: false } : scenario))
  const linkNoUrl = defaultScenarios().map((scenario) =>
    scenario.id === 'link' ? { ...scenario, prompt: 'no link token' } : scenario,
  )
  const tooMany = scenarioBase()
  for (let index = 0; index < MAX_SCENARIOS; index += 1) {
    tooMany.push({
      id: 'extra-' + index,
      label: 'Extra ' + index,
      scope: 'item',
      sections: ['review'],
      prompt: '{url}',
      agent: 'default',
      enabled: true,
    })
  }
  const cases = [
    ['unsafe ssh alias', { sshServers: [{ alias: '-V', agent: 'claude', cwd: '/work' }] }],
    ['duplicate ssh alias', { sshServers: ['build', 'BUILD'].map((alias) => ({ alias, agent: 'codex', cwd: '/work' })) }],
    ['invalid remote alternative', { sshServers: [{ alias: 'build', agent: 'claude', alternatives: ['unknown'] }] }],
    ['invalid remote folder list', { sshServers: [{ alias: 'build', agent: 'claude', folders: ['relative'] }] }],
    ['relative remote cwd', { sshServers: [{ alias: 'build', agent: 'claude', cwd: 'work' }] }],
    ['scenarios is not an array', { scenarios: 'nope' }],
    ['empty scenario list', { scenarios: [] }],
    ['bad id', { scenarios: [...defaultScenarios(), { ...scenarioBase()[10], id: 'Bad Id' }] }],
    ['custom without label', { scenarios: [...defaultScenarios(), { ...scenarioBase()[10], label: '   ' }] }],
    ['empty sections', { scenarios: [...defaultScenarios(), { ...scenarioBase()[10], sections: [] }] }],
    ['oversized prompt', { scenarios: [...defaultScenarios(), { ...scenarioBase()[10], prompt: 'x'.repeat(MAX_SCENARIO_TEMPLATE + 1) }] }],
    ['link disabled', { scenarios: linkDisabled }],
    ['link without url', { scenarios: linkNoUrl }],
    ['unknown agent', { scenarios: [...defaultScenarios(), { ...scenarioBase()[10], agent: 'nobody' }] }],
    ['duplicate ids', { scenarios: [...defaultScenarios(), scenarioBase()[10], scenarioBase()[10]] }],
    ['too many scenarios', { scenarios: tooMany }],
    ['missing link scenario', { scenarios: defaultScenarios().filter((scenario) => scenario.id !== 'link') }],
    ['unknown default scenario', { defaultScenario: 'nope' }],
    ['section default scenario', { defaultScenario: 'review-all' }],
    [
      'disabled default scenario',
      {
        scenarios: defaultScenarios().map((scenario) =>
          scenario.id === 'review-pr' ? { ...scenario, enabled: false } : scenario,
        ),
        defaultScenario: 'review-pr',
      },
    ],
    [
      'ask-at-launch default scenario',
      {
        scenarios: defaultScenarios().map((scenario) =>
          scenario.id === 'review-pr' ? { ...scenario, agent: 'ask' } : scenario,
        ),
        defaultScenario: 'review-pr',
      },
    ],
    ['unknown setting', { promptTemplate: '{url}' }],
  ]
  for (const [name, body] of cases) {
    const res = await callHandler('/triage-desk/config', 'POST', body)
    assert.equal(res.statusCode, 400, name)
    const payload = await json(res)
    assert.equal(payload.error.code, 'invalid-config', name)
    assert.equal(typeof payload.error.message, 'string', name)
  }
})

await recordAsync('config POST waits for persistence and reports write failures', async () => {
  const originalEdit = configEditor.edit
  let finish
  let started
  const saving = new Promise((resolve) => { started = resolve })
  configEditor.edit = () => {
    started()
    return new Promise((resolve) => { finish = resolve })
  }
  let settled = false
  const request = callHandler('/triage-desk/config', 'POST', { refreshSeconds: 1200 }).then((res) => {
    settled = true
    return res
  })
  try {
    await saving
    await Promise.resolve()
    assert.equal(settled, false, 'the response must not claim success while the write is pending')
    finish()
    const res = await request
    assert.equal(res.statusCode, 200)
    assert.equal((await json(res)).ok, true)
    configEditor.edit = async () => { throw new Error('profile is read-only') }
    const failed = await callHandler('/triage-desk/config', 'POST', { refreshSeconds: 1200 })
    assert.equal(failed.statusCode, 500)
    assert.equal((await json(failed)).error.code, 'save-failed')
    assert.match((await json(failed)).error.message, /read-only/)
  } finally {
    if (finish) finish()
    await request
    configEditor.edit = originalEdit
  }
})

await recordAsync('a save that completes in a disposed context is still reported as saved', async () => {
  const originalEdit = configEditor.edit
  const original = { ...logger }
  const disposed = () => { throw new Error('inactive context') }
  try {
    // configEditor.edit settles only after the loader restarted this plugin:
    // by then ctx-bound services such as the logger may throw.
    configEditor.edit = async () => {
      Object.assign(logger, { info: disposed, warn: disposed, error: disposed })
    }
    const saved = await callHandler('/triage-desk/config', 'POST', { refreshSeconds: 1200 })
    assert.equal(saved.statusCode, 200, saved.body)
    assert.equal((await json(saved)).ok, true)
    configEditor.edit = async () => {
      Object.assign(logger, { info: disposed, warn: disposed, error: disposed })
      throw new Error('profile is read-only')
    }
    const failed = await callHandler('/triage-desk/config', 'POST', { refreshSeconds: 1200 })
    assert.equal(failed.statusCode, 500, failed.body)
    assert.equal((await json(failed)).error.code, 'save-failed')
  } finally {
    configEditor.edit = originalEdit
    Object.assign(logger, original)
  }
})

await recordAsync('config GET reports invalidAgents and POST accepts --flag={prompt}', async () => {
  const config = await json(await callHandler('/triage-desk/config', 'GET'))
  assert.deepEqual(config.config.invalidAgents, [])
  captured.edits.length = 0
  const agents = [
    claude,
    codex,
    { id: 'aider', label: 'Aider', command: 'aider --message={prompt}' },
  ]
  const res = await callHandler('/triage-desk/config', 'POST', { agents })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(captured.edits[0].agents, agents)
})

/** GraphQL answer for every snapshot query: an empty but cacheable (`partial`) snapshot. */
const EMPTY_GRAPHQL = JSON.stringify({
  data: {
    viewer: { login: 'octocat', organizations: { nodes: [] } },
    rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-01-01T11:00:00Z' },
  },
})

/**
 * A DSH plugin fiber: a save runs the `internal/update` waterfall documented
 * on the listener in index.js, then (if no listener stopped it) a restart that
 * disposes every owned effect and applies the plugin again. `hookConfig`
 * picks the config value the listeners receive.
 */
function startFiber(initialConfig, hookConfig = (config) => config) {
  const tools = new Map()
  const routes = new Map()
  let effects = new Set()
  let updateHooks = []
  let config = initialConfig
  const stats = { saves: 0, restarts: 0, toolUnregistrations: 0, githubCalls: 0, registeredDuringSave: [], warnings: [] }
  const own = (dispose) => {
    effects.add(dispose)
    return dispose
  }
  const editor = {
    entries: () => [entry],
    edit: async (_entry, change) => {
      stats.saves += 1
      const updating = Promise.resolve(update(change(config, {})))
      // A triage_desk call arriving while the loader applies the save.
      stats.registeredDuringSave.push(tools.has('triage_desk'))
      await updating
      stats.registeredDuringSave.push(tools.has('triage_desk'))
    },
  }
  const fiberCtx = () => ({
    ...ctx,
    logger: () => ({ ...logger, warn: (...args) => stats.warnings.push(args) }),
    effect: (callback) => {
      const disposer = callback()
      return own(typeof disposer === 'function' ? disposer : () => {})
    },
    on: (name, listener) => {
      if (name !== 'internal/update') throw new Error('unexpected listener ' + name)
      updateHooks.push(listener)
      return own(() => {
        updateHooks = updateHooks.filter((hook) => hook !== listener)
      })
    },
    subprocess: {
      ...ctx.subprocess,
      spawn: (spec) => {
        if (spec.argv[1] !== 'api') return ctx.subprocess.spawn(spec)
        stats.githubCalls += 1
        return fakeHandle(0, EMPTY_GRAPHQL, '')
      },
    },
    webServer: {
      // Owned through the ctx.effect that every route registration runs in.
      register: (route) => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register: (definition) => {
        tools.set(definition.name, definition)
        return own(() => {
          tools.delete(definition.name)
          stats.toolUnregistrations += 1
        })
      },
    },
    systemPrompt: { section: () => own(() => {}) },
    get: (name) => (name === 'configEditor' ? editor : ctx.get(name)),
  })
  const restart = async () => {
    stats.restarts += 1
    const disposing = [...effects]
    effects = new Set()
    for (const dispose of disposing) dispose()
    await new Promise((resolve) => setImmediate(resolve))
    apply(fiberCtx(), config)
  }
  const update = (next) => {
    config = next
    const hooks = [...updateHooks]
    const dispatch = () => {
      const hook = hooks.shift()
      return hook === undefined ? restart() : hook(hookConfig(next), dispatch)
    }
    return dispatch()
  }
  apply(fiberCtx(), config)
  const call = async (method, body) => {
    const res = await callHandler('/triage-desk/config', method, body, routes)
    return { status: res.statusCode, body: JSON.parse(res.body) }
  }
  return { call, tools, stats }
}

await recordAsync('a saved invalid agent is reported, then repaired by saving the fixed command', async () => {
  const legacy = { id: 'legacy', label: 'Legacy', command: 'legacy-agent "{prompt}"' }
  const host = startFiber({
    agents: [claude, legacy],
    defaultAgent: 'claude',
    scenarios: [
      ...defaultScenarios(),
      { id: 'legacy-run', label: 'Legacy run', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'legacy', enabled: true },
    ],
  })
  const config = await host.call('GET')
  assert.deepEqual(config.body.config.invalidAgents, [{ ...legacy, reason: 'placeholder' }])
  assert.deepEqual(config.body.config.agents.map((agent) => agent.id), ['claude'])
  assert.ok(config.body.config.scenarios.some((scenario) => scenario.agent === 'legacy'), 'the pinned scenario is kept')

  const stillInvalid = await host.call('POST', { agents: [claude, legacy] })
  assert.equal(stillInvalid.status, 400)
  assert.match(stillInvalid.body.error.message, /agent "legacy" command must contain exactly one \{prompt\}/)
  assert.equal(host.stats.saves, 0)

  const fixed = { ...legacy, command: 'legacy-agent --message={prompt}' }
  const repaired = await host.call('POST', { agents: [claude, fixed] })
  assert.equal(repaired.status, 200, JSON.stringify(repaired.body))
  assert.deepEqual(repaired.body.saved.agents, [claude, fixed])

  const after = await host.call('GET')
  assert.deepEqual(after.body.config.invalidAgents, [])
  assert.deepEqual(after.body.config.agents.map((agent) => agent.id), ['claude', 'legacy'])
})

await recordAsync('a settings save keeps triage_desk registered and applies the settings live', async () => {
  const host = startFiber({ agents: [claude, codex], defaultAgent: 'claude', refreshSeconds: 600 })
  const tool = host.tools.get('triage_desk')
  assert.ok(tool, 'the tool is registered at start')

  const saved = await host.call('POST', { defaultAgent: 'codex', refreshSeconds: 900, terminal: 'iterm' })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.deepEqual(host.stats.registeredDuringSave, [true, true], 'triage_desk stays callable during the save')
  assert.equal(host.stats.restarts, 0, 'the save was applied without a restart')
  assert.equal(host.stats.toolUnregistrations, 0)
  assert.equal(host.tools.get('triage_desk'), tool, 'the same tool registration serves calls after the save')

  const config = await host.call('GET')
  assert.equal(config.body.config.defaultAgent, 'codex', 'the running host serves the saved settings')
  assert.equal(config.body.config.refreshSeconds, 900)
  assert.equal(config.body.config.terminal, 'iterm')

  const again = await host.call('POST', { defaultAgent: 'claude' })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal((await host.call('GET')).body.config.defaultAgent, 'claude', 'a second save applies on top of the first')
  assert.equal(host.stats.restarts, 0)
})

await recordAsync('a launcher-only save keeps the cached snapshot; a GitHub settings change rebuilds it', async () => {
  const host = startFiber({ agents: [claude, codex], defaultAgent: 'claude' })
  const report = () => host.tools.get('triage_desk').execute({})
  assert.equal((await report()).status, 'partial', 'the fake GitHub answers with a cacheable snapshot')
  const built = host.stats.githubCalls
  assert.ok(built > 0, 'the first report builds a snapshot')

  const launcherOnly = await host.call('POST', { defaultAgent: 'codex', terminal: 'iterm', promptDelivery: 'clipboard' })
  assert.equal(launcherOnly.status, 200, JSON.stringify(launcherOnly.body))
  await report()
  assert.equal(host.stats.githubCalls, built, 'no GitHub call after a save that keeps the GitHub settings')

  const github = await host.call('POST', { includeBotReviews: true })
  assert.equal(github.status, 200, JSON.stringify(github.body))
  await report()
  assert.ok(host.stats.githubCalls > built, 'a GitHub settings change builds a new snapshot')
  assert.equal(host.stats.restarts, 0)
})

await recordAsync('a settings save that cannot be applied live falls back to a restart', async () => {
  // normalizeSettings reads the config, so the listener's wire() throws.
  const unwirable = new Proxy({}, { get: () => { throw new Error('settings cannot be wired') } })
  let poisoned = true
  const host = startFiber({ agents: [claude, codex], defaultAgent: 'claude', orgs: ['acme'] }, (config) =>
    poisoned ? unwirable : config,
  )
  const tool = host.tools.get('triage_desk')
  assert.ok(tool, 'the tool is registered at start')

  const saved = await host.call('POST', { defaultAgent: 'codex' })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(host.stats.restarts, 1, 'the failed rewire called next() into the restart')
  assert.equal(host.stats.toolUnregistrations, 1, 'the restart disposed the old tool registration')
  assert.deepEqual(host.stats.registeredDuringSave, [false, true], 'the tool is back once the restart finished')
  assert.ok(
    host.stats.warnings.some((args) => /could not be applied live/.test(args[0]) && /cannot be wired/.test(args[1])),
    'the failed rewire is logged: ' + JSON.stringify(host.stats.warnings),
  )
  const restartedTool = host.tools.get('triage_desk')
  assert.ok(restartedTool, 'the tool is registered again after the restart')
  assert.notEqual(restartedTool, tool, 'the restarted instance registered its own tool')

  const config = await host.call('GET')
  assert.equal(config.body.config.defaultAgent, 'codex', 'the restarted host serves the saved settings')

  poisoned = false
  const again = await host.call('POST', { defaultAgent: 'claude' })
  assert.equal(again.status, 200, JSON.stringify(again.body))
  assert.equal(host.stats.restarts, 1, 'the restarted instance applies the next save live')
  assert.equal((await host.call('GET')).body.config.defaultAgent, 'claude')
})

await recordAsync('config POST rejects unsafe prompt placeholder contexts before persistence', async () => {
  const before = captured.edits.length
  for (const command of ['claude "prefix {prompt}"', "claude 'prefix {prompt}'", 'claude \\{prompt}', 'claude --message="{prompt}"', 'claude {prompt} {prompt}', '{prompt}', 'FOO="two words" {prompt}']) {
    const res = await callHandler('/triage-desk/config', 'POST', {
      agents: [{ id: 'claude', label: 'Claude Code', command }],
    })
    assert.equal(res.statusCode, 400, command)
    const payload = await json(res)
    assert.equal(payload.error.code, 'invalid-agent', command)
    assert.equal(payload.error.agent, 'claude', command)
    assert.match(payload.error.message, /^agent "claude" /, command)
    assert.match(payload.error.message, /exactly one \{prompt\} as its own unquoted argument or as --flag=\{prompt\}/, command)
  }
  assert.equal(captured.edits.length, before, 'invalid command templates never reach the profile writer')
  for (const agents of [[{ id: 'Bad Id', label: 'X', command: 'x {prompt}' }], [{ id: 'claude', label: '', command: 'claude {prompt}' }]]) {
    const other = await json(await callHandler('/triage-desk/config', 'POST', { agents }))
    assert.equal(other.error.code, 'invalid-config', 'other agent errors keep invalid-config')
    assert.equal(other.error.agent, undefined)
  }
})

await recordAsync('config POST checks scenario agents against the patched agent list', async () => {
  const scenarios = [
    ...defaultScenarios(),
    { id: 'codex-only', label: 'Codex only', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'codex', enabled: true },
  ]
  const withCurrentAgents = await callHandler('/triage-desk/config', 'POST', { scenarios })
  assert.equal(withCurrentAgents.statusCode, 200)
  const withPatchedAgents = await callHandler('/triage-desk/config', 'POST', {
    agents: [claude],
    scenarios,
  })
  assert.equal(withPatchedAgents.statusCode, 400)
  await new Promise((resolve) => setTimeout(resolve, 30))
})

await recordAsync('an agents-only patch cannot orphan a saved scenario agent', async () => {
  const res = await callHandler('/triage-desk/config', 'POST', {
    agents: [claude],
  })
  assert.equal(res.statusCode, 400)
  const payload = await json(res)
  assert.equal(payload.error.code, 'invalid-config')
  assert.ok(payload.error.message.includes('codex-review'), payload.error.message)
})

await recordAsync('config POST saves an unedited known agent without its command', async () => {
  captured.edits.length = 0
  const agents = [
    { id: 'codex', label: 'Codex', command: defaultAgentCommand('codex') },
    { id: 'claude', label: 'Claude Code', command: 'claude --model opus {prompt}' },
  ]
  const res = await callHandler('/triage-desk/config', 'POST', { agents, defaultAgent: 'codex' })
  assert.equal(res.statusCode, 200, res.body)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(captured.edits.at(-1).agents, [
    { id: 'codex', label: 'Codex', command: '' },
    { id: 'claude', label: 'Claude Code', command: 'claude --model opus {prompt}' },
  ], 'the unedited command follows the default; the edited one is kept')
  assert.equal(captured.edits.at(-1).agentsVersion, AGENTS_VERSION, 'saved agents are marked as already upgraded')
  const optOut = await callHandler('/triage-desk/config', 'POST', {
    agents: [{ id: 'codex', label: 'Codex', command: 'codex {prompt}' }],
    defaultAgent: 'codex',
  })
  assert.equal(optOut.statusCode, 200, optOut.body)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const afterOptOut = normalizeLauncherConfig(captured.edits.at(-1))
  assert.equal(afterOptOut.agents.find((agent) => agent.id === 'codex').command, 'codex {prompt}',
    'removing the full-access flag sticks')
  // The fake editor records saves without applying them: read the saved config
  // back the way the host loads it.
  const reread = normalizeLauncherConfig(captured.edits[0])
  assert.equal(reread.agents.find((agent) => agent.id === 'codex').command, defaultAgentCommand('codex'),
    'the panel still sees the full command')
})

await recordAsync('config POST accepts scenarios and a default scenario', async () => {
  captured.edits.length = 0
  const scenarios = [
    ...defaultScenarios().map((scenario) =>
      scenario.id === 'review-pr' ? { ...scenario, label: 'My review' } : scenario,
    ),
    {
      id: 'custom-test',
      label: 'Custom test',
      scope: 'section',
      sections: ['issues', 'review'],
      prompt: 'Do {links}\r\nnow',
      agent: 'default',
      enabled: true,
    },
  ]
  const res = await callHandler('/triage-desk/config', 'POST', { scenarios, defaultScenario: 'review-pr' })
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.ok, true)
  assert.equal(payload.saved.defaultScenario, 'review-pr')
  assert.equal(payload.saved.scenarios.length, defaultScenarios().length + 1)
  assert.equal(payload.saved.scenarios[0].id, 'link')
  const custom = payload.saved.scenarios.find((scenario) => scenario.id === 'custom-test')
  assert.equal(custom.prompt, 'Do {links}\nnow')
  assert.deepEqual(custom.sections, ['issues', 'review'])
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(captured.edits.length, 1)
  assert.equal(captured.edits[0].defaultScenario, 'review-pr')
  assert.equal(captured.edits[0].scenarios.length, defaultScenarios().length + 1)
  assert.equal(captured.edits[0].scenariosVersion, 2, 'saved scenario bindings can be edited independently')
  const stored = new Map(captured.edits[0].scenarios.map((scenario) => [scenario.id, scenario.prompt]))
  assert.equal(stored.get('review-pr'), '', 'an unedited built-in prompt is stored empty and follows the default')
  assert.equal(stored.get('custom-test'), 'Do {links}\nnow')
  // The fake editor records saves without applying them: read the saved config
  // back the way the host loads it.
  const reread = normalizeLauncherConfig(captured.edits[0])
  assert.equal(
    reread.scenarios.find((scenario) => scenario.id === 'review-pr').prompt,
    defaultScenarios().find((scenario) => scenario.id === 'review-pr').prompt,
    'the panel still sees the full prompt',
  )
})

await recordAsync('config POST accepts a body larger than the launch limit', async () => {
  captured.edits.length = 0
  const scenarios = defaultScenarios().map((scenario) => ({
    ...scenario,
    prompt: scenario.id === 'link' ? '{url}' : 'x'.repeat(3900),
  }))
  for (let index = 0; index < 19; index += 1) {
    scenarios.push({
      id: 'bulk-' + index,
      label: 'Bulk ' + index,
      scope: 'item',
      sections: ['review'],
      prompt: 'y'.repeat(3900),
      agent: 'default',
      enabled: true,
    })
  }
  const body = { scenarios, defaultScenario: 'link' }
  assert.ok(Buffer.byteLength(JSON.stringify(body)) > 64 * 1024, 'body must exceed the launch limit')
  const res = await callHandler('/triage-desk/config', 'POST', body)
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.saved.scenarios.length, defaultScenarios().length + 19)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(captured.edits.length, 1)
})

await recordAsync('launch rejects a body larger than its own limit', async () => {
  captured.opens.length = 0
  const res = await callHandler('/triage-desk/launch', 'POST', {
    url: PR_URL,
    agent: 'claude',
    title: 'x'.repeat(70 * 1024),
  })
  assert.equal(res.statusCode, 400)
  const payload = await json(res)
  assert.equal(payload.error.code, 'bad-request')
  assert.ok(payload.error.message.includes('too large'))
  assert.equal(captured.opens.length, 0)
})

await recordAsync('config POST merges untouched launcher fields', async () => {
  captured.edits.length = 0
  const res = await callHandler('/triage-desk/config', 'POST', { defaultScenario: 'review-pr' })
  assert.equal(res.statusCode, 200)
  const payload = await json(res)
  assert.equal(payload.ok, true)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(captured.edits.length, 1)
  assert.deepEqual(captured.edits[0], { defaultScenario: 'review-pr' })
})

await recordAsync('native folder picker returns a directory and a clone mapping', async () => {
  captured.pickChoice = workspaceDir
  const dir = await callHandler('/triage-desk/pick-directory', 'POST')
  assert.equal(dir.statusCode, 200)
  assert.equal((await json(dir)).path, workspaceDir)

  captured.pickChoice = cloneDir
  const clone = await callHandler('/triage-desk/pick-clone', 'POST')
  assert.equal(clone.statusCode, 200)
  const payload = await json(clone)
  assert.equal(payload.path, cloneDir)
  assert.equal(payload.repo, 'acme/widgets')

  captured.pickChoice = null
  const cancelled = await callHandler('/triage-desk/pick-directory', 'POST')
  assert.equal((await json(cancelled)).path, null)
})

await recordAsync('the clone picker reads every remote, prefers upstream, and maps SSH aliases', async () => {
  const home = path.join(fixture, 'picker-home')
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true })
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host github-work\n  HostName github.com\n')
  const oldRemotes = captured.gitRemotes
  captured.pickChoice = cloneDir
  await withHome(home, async () => {
    try {
      const pick = async (remotes) => {
        captured.gitRemotes = remotes
        captured.gitCalls.length = 0
        const res = await callHandler('/triage-desk/pick-clone', 'POST')
        const call = captured.gitCalls[0]
        assert.deepEqual(call.slice(1), ['-C', cloneDir, 'config', '--local', '--get-regexp', '^remote\\..*\\.url$'])
        return { status: res.statusCode, body: await json(res) }
      }
      const upstream = await pick(
        'remote.origin.url git@github.com:me/forked-widgets.git\n'
        + 'remote.upstream.url https://github.com/acme/widgets.git\n',
      )
      assert.equal(upstream.status, 200)
      assert.equal(upstream.body.repo, 'acme/widgets')
      const alias = await pick('remote.gitlab.url git@gitlab.com:x/y.git\nremote.work.url git@github-work:acme/x.git\n')
      assert.equal(alias.body.repo, 'acme/x', 'first GitHub remote through the ~/.ssh/config alias')
      const none = await pick('remote.origin.url git@gitlab.com:x/y.git\n')
      assert.equal(none.status, 409)
      assert.equal(none.body.error.code, 'not-a-github-clone')
    } finally {
      captured.gitRemotes = oldRemotes
      captured.pickChoice = null
    }
  })
})

await recordAsync('GitHub auth status and login button', async () => {
  captured.ghAuthenticated = false
  captured.ghMissing = false
  const status = await callHandler('/triage-desk/auth', 'GET')
  assert.equal(status.statusCode, 200)
  const statusPayload = await json(status)
  assert.equal(statusPayload.auth.available, true)
  assert.equal(statusPayload.auth.authenticated, false)

  captured.opens.length = 0
  const login = await callHandler('/triage-desk/auth/login', 'POST')
  assert.equal(login.statusCode, 200)
  assert.equal((await json(login)).already, false)
  const argv = captured.opens.find((entry) => entry.length === 4)
  const script = await fs.readFile(argv[3], 'utf8')
  assert.ok(script.includes('auth login --hostname github.com'))
  await cleanupLaunches()

  captured.ghAuthenticated = true
  const connected = await json(await callHandler('/triage-desk/auth', 'GET'))
  assert.equal(connected.auth.authenticated, true)
  assert.equal(connected.auth.login, 'octocat')
  assert.deepEqual(connected.auth.scopes, ['repo', 'read:org'])

  captured.ghMissing = true
  const missing = await callHandler('/triage-desk/auth', 'GET')
  assert.equal(missing.statusCode, 200)
  const missingPayload = await json(missing)
  assert.equal(missingPayload.auth.available, false)
  assert.equal(missingPayload.auth.install.command, 'brew install gh')
  const denied = await callHandler('/triage-desk/auth/login', 'POST')
  assert.equal(denied.statusCode, 400)
  assert.equal((await json(denied)).error.code, 'gh-missing')
  captured.ghMissing = false
  captured.ghAuthenticated = false
})

await recordAsync('launch writes a .command file opened through Terminal on darwin', async () => {
  captured.opens.length = 0
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'claude' })
  assert.equal(res.statusCode, 200)
  const openArgv = captured.opens.find(
    (entry) => entry.length === 4 && entry[0] === '/usr/bin/open' && entry[1] === '-a' && entry[2] === 'Terminal',
  )
  assert.ok(openArgv, 'the launcher must be opened through Terminal')
  const launcherFile = openArgv[3]
  assert.ok(launcherFile.endsWith('.command'), 'the darwin launcher keeps the .command extension')
  const script = await fs.readFile(launcherFile, 'utf8')
  assert.ok(script.startsWith('#!/bin/zsh\n'))
  assert.ok(script.includes('claude --dangerously-skip-permissions --prefill'))
  await cleanupLaunches()
})

await recordAsync('the darwin terminal plan opens a Terminal window', async () => {
  const scriptPath = '/tmp/triage-desk-launch/launch.command'
  assert.deepEqual(openTerminalPlan('darwin', { scriptPath }), {
    argv: ['/usr/bin/open', '-a', 'Terminal', scriptPath],
    variant: 'window',
    app: 'terminal',
  })
  assert.deepEqual(openTerminalPlan('darwin', { scriptPath, tab: true }), {
    argv: ['/usr/bin/open', '-a', 'Terminal', scriptPath],
    variant: 'window',
    app: 'terminal',
  })
})

await recordAsync('tool launch action uses the same launcher', async () => {
  captured.opens.length = 0
  const result = await captured.tool.execute({ action: 'launch', url: PR_URL, agent: 'claude' })
  assert.ok(result.text.includes('pre-filled'))
  assert.ok(result.text.includes('not been sent'))
  assert.equal(result.launched.mode, 'draft')
  assert.equal(result.launched.cwd, cloneDir)
  assert.equal(result.launched.scenario.id, 'link')
  assert.equal(result.launched.count, 1)
  assert.ok(captured.opens.length >= 1)
  await cleanupLaunches()
})

await recordAsync('tool report action still returns snapshot text', async () => {
  const result = await captured.tool.execute({})
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.startsWith('Triage Desk —') || result.text.includes('snapshot'))
})

await recordAsync('routes are fenced before doing any work', async () => {
  const opens = captured.opens.length
  captured.fence = 401
  const launch = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'claude' })
  assert.equal(launch.statusCode, 401)
  assert.equal(captured.opens.length, opens, 'a fenced launch must not spawn open')
  const config = await callHandler('/triage-desk/config', 'GET')
  assert.equal(config.statusCode, 401)
  const prompt = await callHandler('/triage-desk/prompt', 'POST', { url: PR_URL, scenario: 'custom-review' })
  assert.equal(prompt.statusCode, 401)
  const agents = await callHandler('/triage-desk/agents/find', 'POST', {})
  assert.equal(agents.statusCode, 401)
  captured.fence = null
})

assert.ok(captured.prompt && typeof captured.prompt.text === 'string')
assert.ok(captured.prompt.text.includes('launch'))

await recordAsync('config GET reports terminals, paste support and the platform', async () => {
  const res = await callHandler('/triage-desk/config', 'GET')
  const { config } = await json(res)
  assert.equal(config.platform, 'darwin')
  assert.equal(config.terminal, 'auto')
  assert.equal(config.promptDelivery, 'paste')
  assert.deepEqual(config.terminals.options.map((entry) => entry.id), ['terminal', 'iterm', 'ghostty'])
  assert.ok(['iterm', 'terminal'].includes(config.terminals.auto))
  assert.deepEqual(config.promptPaste, { available: false, reason: 'python-missing', python: null },
    'a Python that fails the probe is reported as missing')
})

await recordAsync('config POST validates the terminal and prompt delivery', async () => {
  const before = captured.edits.length
  for (const body of [{ terminal: 'no-such-terminal' }, { promptDelivery: 'telepathy' }, { promptDelivery: 1 }]) {
    const res = await callHandler('/triage-desk/config', 'POST', body)
    assert.equal(res.statusCode, 400, JSON.stringify(body))
  }
  assert.equal(captured.edits.length, before, 'rejected values are never written')
  const res = await callHandler('/triage-desk/config', 'POST', { terminal: 'Ghostty', promptDelivery: 'clipboard' })
  assert.equal(res.statusCode, 200, res.body)
  assert.deepEqual(captured.edits.at(-1), { terminal: 'ghostty', promptDelivery: 'clipboard' })
})

await recordAsync('without a working Python, agents fall back to the clipboard and say why', async () => {
  captured.opens.length = 0
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'codex' })
  const payload = await json(res)
  assert.equal(payload.mode, 'clipboard')
  assert.deepEqual(payload.delivery, { mode: 'clipboard', pasteBlocked: 'python-missing', platform: 'darwin' })
  assert.equal(typeof payload.terminal.label, 'string')
  await cleanupLaunches()
})

// A second host instance whose login shell has a working python3: agents
// without a native draft get the prompt typed in by the paste wrapper.
captured.pythonOk = true
apply(ctx, {
  agents: [
    { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' },
    { id: 'codex', label: 'Codex', command: 'codex --model=gpt-5 {prompt}' },
  ],
  defaultAgent: 'codex',
  cloneDirs: [path.join(fixture, 'Playground')],
  terminal: 'terminal',
})

await recordAsync('paste mode runs the agent through the Python wrapper with the prompt in a file', async () => {
  captured.opens.length = 0
  captured.clipboard = null
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'review-pr' })
  const payload = await json(res)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(payload.mode, 'paste')
  assert.deepEqual(payload.delivery, { mode: 'paste', pasteBlocked: null, platform: 'darwin' })
  assert.deepEqual(payload.terminal, { id: 'terminal', label: 'Terminal', fallback: false })
  assert.ok(captured.clipboard.startsWith('Review pull request'), 'the clipboard keeps a copy')
  const launcherFile = captured.opens.find((entry) => entry.length === 4)[3]
  const script = await fs.readFile(launcherFile, 'utf8')
  const dir = path.dirname(launcherFile)
  const wrapper = path.join(dir, 'paste-wrapper.py')
  const promptFile = path.join(dir, 'prompt.txt')
  assert.ok(script.includes("'/opt/homebrew/bin/python3' -I '" + wrapper + "' '" + promptFile + "' '/bin/zsh' -c '/opt/homebrew/bin/codex --model=gpt-5'"), script)
  assert.ok(!script.includes('Review pull request'), 'the prompt never appears in the script')
  assert.equal(await fs.readFile(wrapper, 'utf8'), PASTE_WRAPPER_PY)
  assert.ok((await fs.readFile(promptFile, 'utf8')).startsWith('Review pull request ' + PR_URL))
  const tool = await captured.tool.execute({ action: 'launch', url: PR_URL })
  assert.match(tool.text, /typed into the agent's input box and has not been sent/)
  assert.equal(tool.launched.mode, 'paste')
  await cleanupLaunches()
})

await recordAsync('a native draft agent keeps its draft when paste mode is on', async () => {
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'claude' })
  const payload = await json(res)
  assert.equal(payload.mode, 'draft')
  assert.equal(payload.delivery.pasteBlocked, null)
  await cleanupLaunches()
})

// A third host instance whose saved default agent is not installed.
apply(ctx, {
  agents: [
    { id: 'missing', label: 'Missing Agent', command: 'missing-agent {prompt}' },
    { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
  ],
  defaultAgent: 'missing',
  cloneDirs: [path.join(fixture, 'Playground')],
  terminal: 'terminal',
})

await recordAsync('a default agent that is not installed falls back to the first installed one', async () => {
  const config = await json(await callHandler('/triage-desk/config', 'GET'))
  assert.equal(config.config.defaultAgent, 'missing', 'the saved choice is kept')
  assert.equal(config.config.effectiveDefaultAgent, 'codex', 'launches use the first installed agent')
  assert.equal(config.config.defaultTarget, 'dsh', 'the panel opens a DSH chat instead of the missing agent')
  const reserved = await callHandler('/triage-desk/config', 'POST', { agents: [{ id: 'dsh', label: 'My dsh', command: 'dsh-cli {prompt}' }] })
  assert.equal(reserved.statusCode, 400)
  assert.match((await json(reserved)).error.message, /"dsh" is reserved/)
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'review-pr' })
  const payload = await json(res)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(payload.agent.id, 'codex')
  const explicit = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'missing' })
  assert.equal(explicit.statusCode, 400, 'an explicitly chosen missing agent is still an error')
  assert.equal((await json(explicit)).error.code, 'agent-missing')
  await cleanupLaunches()
})

// A fresh profile: nothing saved. The default opens DSH, and the agent list is
// what detection finds on the machine (here Claude Code and Codex).
captured.installed = ['claude', 'codex', 'python3', 'gh']
apply(ctx, {
  cloneDirs: [path.join(fixture, 'Playground')],
  terminal: 'terminal',
  // Referenced by a scenario pin but not installed: it stays in the list.
  scenarios: [...defaultScenarios(), { id: 'gem', label: 'Gemini run', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'gemini', enabled: true }],
})

await recordAsync('a fresh profile defaults to DSH and lists only installed agents', async () => {
  const config = (await json(await callHandler('/triage-desk/config', 'GET'))).config
  assert.equal(config.defaultAgent, 'dsh')
  assert.equal(config.defaultTarget, 'dsh', 'the panel opens a DSH chat')
  assert.deepEqual(config.agents.map((agent) => agent.id), ['claude', 'codex', 'gemini'],
    'installed agents, plus a missing one a scenario still points to (so Settings can save)')
  assert.equal(config.detectedAgents.gemini.available, false)
  assert.equal(config.effectiveDefaultAgent, 'claude', 'a launch the host runs uses the first installed agent')
  const res = await callHandler('/triage-desk/launch', 'POST', { url: PR_URL, scenario: 'review-pr' })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal((await json(res)).agent.id, 'claude')
  await cleanupLaunches()
})

await fs.rm(fixture, { recursive: true, force: true })

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} route checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('routes smoke OK')
}
