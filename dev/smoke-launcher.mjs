/**
 * Dev smoke test for the terminal launcher helpers: scenario normalization and
 * validation, prompt rendering, clone discovery/matching, the generated macOS
 * `.command` and Windows `.ps1` scripts, and the platform terminal opener
 * plans. Runs entirely in a temp directory; never opens a terminal.
 * Run with `npm run smoke:launcher`.
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { apply } from '../index.js'
import {
  AGENT_PRESETS,
  BUILTIN_SCENARIOS,
  BUILTIN_SCENARIO_TITLES,
  MAX_RENDERED_PROMPT,
  MAX_SCENARIO_TEMPLATE,
  MAX_SCENARIOS,
  SCENARIO_SECTION_IDS,
  agentExecutable,
  bareAgentCommand,
  buildClipboardLauncherScript,
  buildDraftCommand,
  buildDraftLauncherScript,
  buildItemsBlock,
  buildItermTabAppleScript,
  buildLoginLauncherScript,
  buildScenarioPrompt,
  buildWindowsClipboardLauncherScript,
  buildWindowsDraftLauncherScript,
  buildWindowsLoginLauncherScript,
  defaultScenarios,
  discoverCloneRoots,
  focusTerminalPlan,
  matchClone,
  normalizeLauncherConfig,
  normalizeScenarios,
  openTerminalPlan,
  parseRepoUrl,
  promptVars,
  scanCloneDirs,
  scenarioTitle,
  shellQuote,
  validateDefaultScenario,
  validateScenario,
  buildExecutableProbe,
  chooseCloneRepo,
  classifyProbeAnswer,
  hasSafePromptPlaceholder,
  lookupRepoPath,
  parseExecutableProbe,
  parseSshConfigHosts,
  remoteToRepo,
  withAgentExecutable,
} from '../launcher.js'

const checks = []
function check(name, callback) {
  try {
    callback()
    checks.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

async function checkAsync(name, callback) {
  try {
    await callback()
    checks.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

const PR_URL = 'https://github.com/acme/widgets/pull/288'
const BRANCH_URL = 'https://github.com/acme/widgets/tree/main'
const prItem = {
  url: PR_URL,
  kind: 'pull',
  number: 288,
  title: 'Add feature',
  headRefName: 'feature-x',
  repo: 'acme/widgets',
  author: { login: 'octocat' },
  reason: 'ready-to-merge',
  section: 'merge',
}
const branchItem = {
  url: BRANCH_URL,
  kind: 'branch',
  ref: 'main',
  title: 'main — acme/widgets',
  repo: 'acme/widgets',
  author: { login: 'octocat' },
  reason: 'branch-checks-failing',
  section: 'ci',
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-desk-smoke-'))
const cloneA = path.join(fixture, 'Playground', 'widgets')
const cloneB = path.join(fixture, 'Playground', 'other', 'relay')
const skippedClone = path.join(fixture, 'Playground', 'node_modules', 'ignored')
const missingDir = path.join(fixture, 'missing')

await fs.mkdir(path.join(cloneA, '.git'), { recursive: true })
await fs.mkdir(path.join(cloneB, '.git'), { recursive: true })
await fs.mkdir(path.join(skippedClone, '.git'), { recursive: true })
await fs.writeFile(
  path.join(cloneA, '.git', 'config'),
  '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
)
await fs.writeFile(
  path.join(cloneB, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/acme/relay.git\n',
)
await fs.writeFile(
  path.join(skippedClone, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/acme/private-notes.git\n',
)

check('presets cover the documented agents', () => {
  const ids = AGENT_PRESETS.map((agent) => agent.id)
  for (const id of ['claude', 'codex', 'opencode', 'gemini', 'cursor-agent', 'agy', 'pi']) assert.ok(ids.includes(id), id)
  assert.deepEqual(
    AGENT_PRESETS.filter((agent) => agent.draftFlag !== undefined).map((agent) => agent.id),
    ['claude'],
  )
})

check('default config is neutral', () => {
  const config = normalizeLauncherConfig({})
  assert.equal(config.defaultAgent, 'claude')
  assert.equal(config.defaultScenario, 'link')
  assert.equal(config.scenarios.length, BUILTIN_SCENARIOS.length)
  const link = config.scenarios[0]
  assert.equal(link.id, 'link')
  assert.equal(link.label, '')
  assert.equal(link.scope, 'item')
  assert.equal(link.agent, 'default')
  assert.equal(link.enabled, true)
  assert.equal(link.prompt, '{url}')
  assert.deepEqual(link.sections, SCENARIO_SECTION_IDS)
  assert.equal(config.promptTemplate, undefined)
  assert.equal(config.agents.find((agent) => agent.id === 'claude').draftFlag, '--prefill')
  assert.equal(config.cloneDirs.length, 0)
  assert.equal(config.agents.length, AGENT_PRESETS.length)
})

check('builtin scenarios are complete and titled', () => {
  assert.equal(BUILTIN_SCENARIOS.length, 10)
  assert.deepEqual(
    BUILTIN_SCENARIOS.map((scenario) => scenario.id),
    ['link', 'review-pr', 'rereview-pr', 'fix-pr', 'reply-thread', 'triage-issue', 'review-all', 'fix-mine', 'triage-new', 'reply-mentions'],
  )
  for (const scenario of BUILTIN_SCENARIOS) {
    assert.equal(scenario.agent, 'default', scenario.id)
    assert.ok(BUILTIN_SCENARIO_TITLES[scenario.id], scenario.id)
    assert.ok(scenario.sections.length >= 1 && scenario.sections.length <= 6, scenario.id)
    assert.ok(typeof scenario.prompt === 'string' && scenario.prompt.trim() !== '', scenario.id)
  }
  assert.ok(BUILTIN_SCENARIOS.find((scenario) => scenario.id === 'review-pr').prompt.includes('strict senior reviewer'))
  assert.ok(BUILTIN_SCENARIOS.find((scenario) => scenario.id === 'review-all').prompt.includes('{links}'))
  for (const scenario of BUILTIN_SCENARIOS.filter((entry) => entry.scope === 'section')) {
    assert.ok(/sub-agent/i.test(scenario.prompt), scenario.id + ' should delegate items to sub-agents')
  }
})

check('default scenarios are fresh copies', () => {
  const first = defaultScenarios()
  const second = defaultScenarios()
  first[0].sections.push('review')
  first[1].label = 'changed'
  assert.deepEqual(second[0].sections, SCENARIO_SECTION_IDS)
  assert.equal(second[1].label, '')
  assert.notEqual(first[0].sections, BUILTIN_SCENARIOS[0].sections)
  assert.notEqual(first[0].sections, second[0].sections)
})

check('custom agents are normalized and validated', () => {
  const config = normalizeLauncherConfig({
    agents: [
      { id: 'My-Agent', label: 'Mine', command: 'my-agent {prompt}' },
      { id: 'broken', label: 'Broken', command: 'no-placeholder' },
    ],
    defaultAgent: 'missing',
  })
  assert.equal(config.agents.length, 1)
  assert.equal(config.agents[0].id, 'my-agent')
  assert.equal(config.defaultAgent, 'my-agent')
  assert.deepEqual(config.invalidAgents, [{ id: 'broken', label: 'Broken', command: 'no-placeholder', reason: 'placeholder' }])
  assert.deepEqual(normalizeLauncherConfig({}).invalidAgents, [])
})

check('the default scenario falls back to link for non-item ids', () => {
  assert.equal(normalizeLauncherConfig({ defaultScenario: 'review-pr', scenarios: defaultScenarios() }).defaultScenario, 'review-pr')
  assert.equal(normalizeLauncherConfig({ defaultScenario: 'review-all', scenarios: defaultScenarios() }).defaultScenario, 'link')
  assert.equal(normalizeLauncherConfig({ defaultScenario: 'unknown', scenarios: defaultScenarios() }).defaultScenario, 'link')
})

check('custom scenarios round-trip through normalization', () => {
  const normalized = normalizeScenarios([
    { id: 'link', scope: 'item', sections: SCENARIO_SECTION_IDS, prompt: '{url}', agent: 'default', enabled: true },
    {
      id: 'my-run',
      label: '  My run  ',
      scope: 'section',
      sections: ['issues', 'issues', 'nope', 'review'],
      prompt: 'Do {links}\r\nnow',
      agent: 'CODEX',
      enabled: false,
    },
  ])
  assert.equal(normalized.length, 2)
  assert.deepEqual(normalized[1], {
    id: 'my-run',
    label: 'My run',
    scope: 'section',
    sections: ['issues', 'review'],
    prompt: 'Do {links}\nnow',
    agent: 'codex',
    enabled: false,
  })
})

check('invalid scenarios are dropped and repairable fields default', () => {
  const normalized = normalizeScenarios([
    { id: 'link', scope: 'item', sections: SCENARIO_SECTION_IDS, prompt: '{url}', agent: 'default', enabled: true },
    'not an object',
    null,
    [],
    { id: 'Bad Id', label: 'X', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'dup', label: 'One', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'dup', label: 'Two', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'no-label', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'empty-prompt', label: 'Empty', scope: 'item', sections: ['review'], prompt: '   ', agent: 'default', enabled: true },
    { id: 'weird-agent', label: 'Weird agent', scope: 'wat', sections: ['nope'], prompt: '{url}', agent: 'Not An Id!', enabled: true },
  ])
  assert.deepEqual(
    normalized.map((scenario) => scenario.id),
    ['link', 'dup', 'weird-agent'],
  )
  const repaired = normalized.find((scenario) => scenario.id === 'weird-agent')
  assert.equal(repaired.scope, 'item')
  assert.equal(repaired.agent, 'default')
  assert.deepEqual(repaired.sections, SCENARIO_SECTION_IDS)
  assert.equal(repaired.enabled, true)
  assert.equal(normalizeScenarios('broken input').length, BUILTIN_SCENARIOS.length)
  assert.equal(normalizeScenarios([]).length, BUILTIN_SCENARIOS.length)
})

check('the link scenario is protected and stays first', () => {
  const forced = normalizeScenarios([
    { id: 'link', label: '', scope: 'item', sections: ['review'], prompt: 'no link token', agent: 'default', enabled: false },
    { id: 'mine', label: 'Mine', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
  ])
  assert.equal(forced[0].id, 'link')
  assert.equal(forced[0].enabled, true)
  assert.equal(forced[0].prompt, '{url}')
  const sectionLink = normalizeScenarios([
    { id: 'link', label: '', scope: 'section', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
  ])
  assert.equal(sectionLink[0].scope, 'item')
  const moved = normalizeScenarios([
    { id: 'mine', label: 'Mine', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'link', label: '', scope: 'item', sections: SCENARIO_SECTION_IDS, prompt: '{url}', agent: 'default', enabled: true },
  ])
  assert.deepEqual(moved.map((scenario) => scenario.id), ['link', 'mine'])
  const prepended = normalizeScenarios([
    { id: 'mine', label: 'Mine', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
  ])
  assert.deepEqual(prepended.map((scenario) => scenario.id), ['link', 'mine'])
})

check('scenarios are capped keeping the link first', () => {
  const entries = [{ id: 'link', scope: 'item', sections: SCENARIO_SECTION_IDS, prompt: '{url}', agent: 'default', enabled: true }]
  for (let index = 0; index < MAX_SCENARIOS + 10; index += 1) {
    entries.push({ id: 'scenario-' + index, label: 'Scenario ' + index, scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true })
  }
  const capped = normalizeScenarios(entries)
  assert.equal(capped.length, MAX_SCENARIOS)
  assert.equal(capped[0].id, 'link')
  assert.equal(capped[1].id, 'scenario-0')
})

check('validateScenario accepts valid scenarios', () => {
  const agents = [{ id: 'claude' }, { id: 'codex' }]
  const valid = [
    { id: 'link', label: '', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true },
    { id: 'review-pr', label: '', scope: 'item', sections: ['review'], prompt: 'Review {url}', agent: 'default', enabled: true },
    { id: 'custom', label: 'Custom', scope: 'section', sections: ['issues'], prompt: 'Do {links}', agent: 'codex', enabled: false },
  ]
  for (const scenario of valid) assert.deepEqual(validateScenario(scenario, agents), { ok: true }, scenario.id)
})

check('validateScenario rejects every invalid shape', () => {
  const agents = [{ id: 'claude' }]
  const base = { id: 'custom', label: 'Custom', scope: 'item', sections: ['review'], prompt: '{url}', agent: 'default', enabled: true }
  const invalid = [
    ['bad id', { ...base, id: 'Bad Id' }],
    ['empty custom label', { ...base, label: '   ' }],
    ['empty sections', { ...base, sections: [] }],
    ['duplicate sections', { ...base, sections: ['review', 'review'] }],
    ['unknown section', { ...base, sections: ['nope'] }],
    ['oversized prompt', { ...base, prompt: 'x'.repeat(MAX_SCENARIO_TEMPLATE + 1) }],
    ['empty prompt', { ...base, prompt: '  ' }],
    ['link without url', { ...base, id: 'link', label: '', prompt: 'no token' }],
    ['link disabled', { ...base, id: 'link', label: '', enabled: false }],
    ['unknown agent', { ...base, agent: 'nope' }],
    ['bad enabled', { ...base, enabled: 'yes' }],
    ['not an object', null],
  ]
  for (const [name, scenario] of invalid) {
    const result = validateScenario(scenario, agents)
    assert.equal(result.ok, false, name)
    assert.equal(typeof result.error, 'string', name)
    assert.ok(result.error.length > 0, name)
  }
})

check('validateDefaultScenario only accepts item scenarios', () => {
  const scenarios = defaultScenarios()
  assert.deepEqual(validateDefaultScenario('review-pr', scenarios), { ok: true })
  assert.equal(validateDefaultScenario('review-all', scenarios).ok, false)
  assert.equal(validateDefaultScenario('unknown', scenarios).ok, false)
  assert.equal(validateDefaultScenario('', scenarios).ok, false)
  const disabled = defaultScenarios()
  disabled.find((scenario) => scenario.id === 'review-pr').enabled = false
  assert.equal(validateDefaultScenario('review-pr', disabled).ok, false)
})

check('GitHub URLs parse to repository slugs', () => {
  assert.deepEqual(parseRepoUrl('https://github.com/acme/widgets/pull/288'), {
    owner: 'acme',
    name: 'widgets',
    slug: 'acme/widgets',
  })
  assert.equal(parseRepoUrl('https://github.com/acme/relay.git').slug, 'acme/relay')
  assert.equal(parseRepoUrl('https://gitlab.com/acme/relay'), null)
  assert.equal(parseRepoUrl('not a url'), null)
  assert.equal(parseRepoUrl('file:///etc/passwd'), null)
})

check('prompt variables include the author and the raw reason', () => {
  const vars = promptVars({ url: PR_URL, author: { login: 'octocat' }, reason: 'ready-to-merge', title: 'A title' })
  assert.equal(vars.url, PR_URL)
  assert.equal(vars.repo, 'acme/widgets')
  assert.equal(vars.author, 'octocat')
  assert.equal(vars.reason, 'ready-to-merge')
  assert.equal(promptVars({ url: PR_URL, author: 'hubot' }).author, 'hubot')
  assert.equal(promptVars({ url: 'https://example.com/x' }), null)
})

check('item blocks list sections, bullets, authors, and reasons', () => {
  const block = buildItemsBlock([prItem, branchItem])
  assert.match(block.text, /^Items: 2 · sections: ready to merge \+ failing CI · date: \d{4}-\d{2}-\d{2}\n\n/)
  assert.equal(block.shown, 2)
  assert.equal(block.total, 2)
  assert.ok(
    block.text.includes(`- [Add feature](${PR_URL}) — acme/widgets#288, author octocat, reason: approved and ready to merge`),
  )
  assert.ok(
    block.text.includes(
      `- [main — acme/widgets](${BRANCH_URL}) — acme/widgets branch main, author octocat, reason: branch checks are failing`,
    ),
  )
})

check('item blocks degrade gracefully', () => {
  const noMeta = buildItemsBlock([{ url: 'https://github.com/acme/app/pull/1', number: 1, title: '', section: 'review' }])
  assert.match(noMeta.text, /^Items: 1 · sections: awaiting my review · date: /)
  assert.ok(noMeta.text.includes('- [acme/app](https://github.com/acme/app/pull/1) — acme/app#1'))
  assert.ok(!noMeta.text.includes(', author'))
  assert.ok(!noMeta.text.includes('reason:'))
  const unknownSection = buildItemsBlock([{ url: 'https://github.com/acme/app/pull/2', number: 2 }])
  assert.ok(unknownSection.text.startsWith('Items: 1 · sections: unknown · date: '))
  const unknownReason = buildItemsBlock([{ url: 'https://github.com/acme/app/pull/3', number: 3, reason: 'weird-code' }])
  assert.ok(unknownReason.text.includes('reason: weird-code'))
  const badUrl = buildItemsBlock([prItem, { url: 'https://example.com/x', title: 'Nope' }])
  assert.equal(badUrl.total, 1)
  assert.equal(badUrl.shown, 1)
})

check('item scenario prompts replace known tokens and keep unknown braces', () => {
  const built = buildScenarioPrompt(
    {
      id: 'custom',
      label: '',
      scope: 'item',
      prompt: 'PR {repo} #{number} by {author} ({reason}) at {url} {bogus} ({branch})',
    },
    { item: prItem },
  )
  assert.ok(built.prompt.includes('PR acme/widgets #288 by octocat (ready-to-merge) at ' + PR_URL))
  assert.ok(built.prompt.includes('{bogus}'))
  assert.ok(built.prompt.includes('feature-x'))
  assert.equal(built.trimmed, null)
})

check('item scenarios append the block only when the template has no link token', () => {
  const appended = buildScenarioPrompt({ scope: 'item', prompt: 'Look at this' }, { item: prItem })
  assert.ok(appended.prompt.startsWith('Look at this\n\nItems: 1 · sections: ready to merge'))
  assert.ok(appended.prompt.includes(PR_URL))
  const explicit = buildScenarioPrompt({ scope: 'item', prompt: 'Look at {url}' }, { item: prItem })
  assert.ok(explicit.prompt.startsWith('Look at ' + PR_URL))
  assert.ok(!explicit.prompt.includes('Items:'))
})

check('item prompts truncate by code point without splitting an emoji', () => {
  const prefix = 'x'.repeat(MAX_RENDERED_PROMPT - 1) + '😀'
  const built = buildScenarioPrompt({ scope: 'item', prompt: prefix + 'y'.repeat(10) }, { item: prItem })
  assert.equal(Array.from(built.prompt).length, MAX_RENDERED_PROMPT + 1)
  assert.ok(built.prompt.endsWith('😀…'))
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(built.prompt))
})

check('section scenario prompts fill links, count, section, and date', () => {
  const second = {
    url: 'https://github.com/acme/widgets/pull/7',
    number: 7,
    title: 'Second',
    repo: 'acme/widgets',
    section: 'review',
    author: 'hubot',
    reason: 'review-requested',
  }
  const built = buildScenarioPrompt(
    {
      id: 'custom',
      label: '',
      scope: 'section',
      prompt: 'Handle {count} items in {section} on {date} {bogus}:\n{links}',
    },
    { items: [prItem, second], section: 'review' },
  )
  assert.ok(built.prompt.startsWith('Handle 2 items in awaiting my review on '))
  assert.match(built.prompt, /on \d{4}-\d{2}-\d{2} \{bogus\}:/)
  assert.ok(built.prompt.includes('Items: 2 · sections: awaiting my review'))
  assert.equal(built.prompt.split('\n- [').length - 1, 2)
  assert.equal(built.trimmed, null)
  assert.ok(built.prompt.includes('reason: my review requested'))
})

check('section scenarios append the block when the template has no {links}', () => {
  const built = buildScenarioPrompt({ scope: 'section', prompt: 'Handle {count} items' }, { items: [prItem], section: 'merge' })
  assert.ok(built.prompt.startsWith('Handle 1 items\n\nItems: 1 · sections: ready to merge'))
})

check('section prompts drop bullets from the end and report the trimming', () => {
  const items = []
  for (let index = 0; index < 100; index += 1) {
    items.push({
      url: `https://github.com/acme/app/pull/${index + 1}`,
      repo: 'acme/app',
      number: index + 1,
      title: 'T'.repeat(200),
      section: 'review',
      author: { login: 'octocat' },
      reason: 'review-requested',
    })
  }
  const built = buildScenarioPrompt({ scope: 'section', prompt: 'Review everything:\n{links}' }, { items, section: 'review' })
  assert.notEqual(built.trimmed, null)
  assert.ok(built.trimmed.shown >= 1 && built.trimmed.shown < built.trimmed.total)
  assert.equal(built.trimmed.total, 100)
  assert.ok(built.prompt.includes(`Items: first ${built.trimmed.shown} of 100`))
  assert.ok(
    built.prompt.includes(`${100 - built.trimmed.shown} more item(s) were omitted to fit the prompt limit; narrow the filter to include them.`),
  )
  assert.equal(built.prompt.split('\n- [').length - 1, built.trimmed.shown)
  assert.ok(Array.from(built.prompt).length <= MAX_RENDERED_PROMPT)
})

check('section prompts truncate safely when even one item cannot fit', () => {
  const items = [
    { url: 'https://github.com/acme/app/pull/1', number: 1, title: 'One', section: 'review' },
    { url: 'https://github.com/acme/app/pull/2', number: 2, title: 'Two', section: 'review' },
  ]
  const built = buildScenarioPrompt(
    { scope: 'section', prompt: 'x'.repeat(MAX_RENDERED_PROMPT) + ' {links}' },
    { items, section: 'review' },
  )
  assert.deepEqual(built.trimmed, { shown: 1, total: 2 })
  assert.equal(Array.from(built.prompt).length, MAX_RENDERED_PROMPT + 1)
  assert.ok(built.prompt.endsWith('…'))
})

check('scenario titles fall back from label to builtin title to id', () => {
  assert.equal(scenarioTitle({ id: 'review-all', label: '' }), 'Review everything awaiting me')
  assert.equal(scenarioTitle({ id: 'link', label: '' }), 'Just the link')
  assert.equal(scenarioTitle({ id: 'custom', label: 'My title' }), 'My title')
  assert.equal(scenarioTitle({ id: 'custom', label: '   ' }), 'custom')
  assert.equal(scenarioTitle(null), '')
})

check('shell quoting survives single quotes', () => {
  const quoted = shellQuote("it's a 'test'")
  assert.equal(quoted, "'it'\\''s a '\\''test'\\'''")
})

check('agent executable ignores env assignments', () => {
  assert.equal(agentExecutable('claude {prompt}'), 'claude')
  assert.equal(agentExecutable('FOO=1 opencode --prompt {prompt}'), 'opencode')
  assert.equal(agentExecutable('/opt/homebrew/bin/codex {prompt}'), '/opt/homebrew/bin/codex')
})

check('executable detection understands quoted paths and assignment values', () => {
  assert.equal(agentExecutable('FOO="two words" "/opt/Agent Tools/claude" {prompt}', 'darwin'), '/opt/Agent Tools/claude')
  assert.equal(agentExecutable('/opt/Agent\\ Tools/claude {prompt}', 'linux'), '/opt/Agent Tools/claude')
  assert.equal(agentExecutable('"C:\\Program Files\\Agent\\claude.exe" {prompt}', 'win32'), 'C:\\Program Files\\Agent\\claude.exe')
  assert.equal(agentExecutable('C:\\Tools\\claude.exe {prompt}', 'win32'), 'C:\\Tools\\claude.exe')
})

check('clipboard mode preserves static quoted argument bytes', () => {
  const template = 'printf \'<%s>\\n\' --label "two   spaces" --prompt {prompt} --mode "stay   put"'
  const bare = bareAgentCommand(template)
  const result = spawnSync('/bin/sh', ['-c', bare], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '<--label>\n<two   spaces>\n<--mode>\n<stay   put>\n')
  assert.equal(bareAgentCommand('agent "--prompt" {prompt} --label "a  b"'), 'agent --label "a  b"')
})

check('Windows invocations preserve quoted paths and static arguments', () => {
  const agentCommand = '"C:\\Program Files\\Agent\\claude.exe" --label "two   spaces" {prompt}'
  const draft = buildWindowsDraftLauncherScript({ cwd: 'C:\\work', title: 'test', agentCommand, promptFile: 'C:\\prompt.txt', draftFlag: '--prefill' })
  assert.ok(draft.includes("& 'C:\\Program Files\\Agent\\claude.exe' '--label' 'two   spaces' '--prefill' $prompt"), draft)
  const clipboard = buildWindowsClipboardLauncherScript({ cwd: 'C:\\work', title: 'test', bareCommand: bareAgentCommand(agentCommand) })
  assert.ok(clipboard.includes("& 'C:\\Program Files\\Agent\\claude.exe' '--label' 'two   spaces'"), clipboard)
  const staticDollar = buildWindowsDraftLauncherScript({ cwd: 'C:\\work', title: 'test', agentCommand: 'claude --label \'$prompt\' {prompt}', promptFile: 'C:\\prompt.txt', draftFlag: '--prefill' })
  assert.ok(staticDollar.includes("& 'claude' '--label' '$prompt' '--prefill' $prompt"), staticDollar)
})

check('bare commands drop the prompt and its flag', () => {
  assert.equal(bareAgentCommand('claude {prompt}'), 'claude')
  assert.equal(bareAgentCommand('opencode --prompt {prompt}'), 'opencode')
  assert.equal(bareAgentCommand('my-agent --message={prompt}'), 'my-agent')
  assert.equal(bareAgentCommand('aider --model=x --message={prompt} --yes'), 'aider --model=x --yes')
  assert.equal(bareAgentCommand('my-agent --model=opus {prompt}'), 'my-agent --model=opus', 'a complete flag=value stays')
  assert.throws(() => bareAgentCommand('my-agent --message="{prompt}"'), /\{prompt\}/)
})

check('login launcher runs gh auth login and keeps the window open', () => {
  const script = buildLoginLauncherScript({
    cwd: '/tmp/workspace',
    ghCommand: '/opt/homebrew/bin/gh',
  })
  assert.ok(script.includes("cd -- '/tmp/workspace'"))
  assert.ok(script.includes("'/opt/homebrew/bin/gh' auth login --hostname github.com"))
  assert.ok(script.includes('exec /bin/zsh -i'))
})

check('prompt substitution rejects quoted, escaped, embedded and repeated placeholders', () => {
  const unsafe = [
    'claude "prefix {prompt}"',
    "claude 'prefix {prompt}'",
    'claude \\{prompt}',
    'claude --message="{prompt}"',
    'claude {prompt} {prompt}',
    'echo `claude {prompt} `',
    'echo "$(claude " {prompt} ")"',
    'claude ${OPTION:-"x" {prompt} }',
    'claude prefix\\ {prompt}',
    'claude $\'prefix {prompt}\'',
    'claude # {prompt}',
    '(( value = {prompt} ))',
    'claude {prompt} && other-command',
    'claude\u00a0{prompt}',
    '{prompt}',
    'FOO=x {prompt}',
    'FOO="two words" BAR=1 {prompt}',
  ]
  for (const command of unsafe) {
    const config = normalizeLauncherConfig({ agents: [{ id: 'unsafe', label: 'Unsafe', command }] })
    assert.equal(config.agents.some((agent) => agent.id === 'unsafe'), false, command)
    assert.throws(() => buildDraftCommand(command, '$(printf INJECTED)', '--prefill'), /\{prompt\}/, command)
    assert.throws(() => buildWindowsDraftLauncherScript({ cwd: 'C:\\work', title: 'test', agentCommand: command, promptFile: 'C:\\prompt.txt', draftFlag: '--prefill' }), /\{prompt\}/, command)
  }
  for (const command of ['FOO="two words" /opt/agent --option \'literal $HOME\' {prompt}', '"C:\\Program Files\\agent.exe" {prompt}', 'claude\t{prompt}']) {
    const config = normalizeLauncherConfig({ agents: [{ id: 'safe', label: 'Safe', command }] })
    assert.equal(config.agents[0].id, 'safe', command)
  }
  const prompt = '$(printf INJECTED) `printf BACKTICK` "quotes" and single\'quotes'
  const command = buildDraftCommand('printf "%s\\n" {prompt}', prompt, '--prefill')
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '--prefill\n' + prompt + '\n', 'untrusted prompt content stays literal shell data')
})

check('native draft command uses the agent flag and quotes the prompt', () => {
  assert.equal(
    buildDraftCommand('claude {prompt}', "https://example.com/a b", '--prefill'),
    "claude --prefill 'https://example.com/a b'",
  )
  const script = buildDraftLauncherScript({
    cwd: '/tmp/clone',
    title: 'Triage Desk: repo',
    command: "claude --prefill 'https://example.com/a b'",
  })
  assert.ok(script.includes('cd -- \'/tmp/clone\''))
  assert.ok(script.includes("claude --prefill 'https://example.com/a b'\n"))
  assert.ok(!script.includes('ZDOTDIR'))
})

check('clipboard launcher starts the bare agent and mentions the clipboard', () => {
  const script = buildClipboardLauncherScript({
    cwd: '/tmp/clone',
    title: 'Triage Desk: repo',
    bareCommand: 'claude',
  })
  assert.ok(script.startsWith('#!/bin/zsh\n'))
  assert.ok(script.includes('cd -- \'/tmp/clone\''))
  assert.ok(script.includes('clipboard'))
  assert.ok(script.includes('\nclaude\n'))
  assert.ok(!script.includes('{prompt}'))
})

check('linux launcher scripts use sh and the user login shell', () => {
  const draft = buildDraftLauncherScript({
    cwd: '/home/me/repo',
    title: 'Triage Desk: repo',
    command: "claude --prefill 'https://example.test/a b'",
    platform: 'linux',
  })
  assert.ok(draft.startsWith('#!/bin/sh\n'))
  assert.ok(draft.includes('exec "${SHELL:-/bin/sh}" -i'))
  assert.ok(!draft.includes('/bin/zsh'))
  const clipboard = buildClipboardLauncherScript({
    cwd: '/home/me/repo',
    title: 'Triage Desk: repo',
    bareCommand: 'codex',
    platform: 'linux',
  })
  assert.ok(clipboard.startsWith('#!/bin/sh\n'))
  assert.ok(clipboard.includes('exec "${SHELL:-/bin/sh}" -i'))
  const login = buildLoginLauncherScript({ cwd: '/home/me/repo', ghCommand: '/usr/bin/gh', platform: 'linux' })
  assert.ok(login.startsWith('#!/bin/sh\n'))
  assert.ok(login.includes('exec "${SHELL:-/bin/sh}" -i'))
  // The default platform stays macOS, byte-for-byte as before.
  assert.equal(
    buildDraftLauncherScript({ cwd: '/tmp/repo', title: 't', command: 'claude' }),
    buildDraftLauncherScript({ cwd: '/tmp/repo', title: 't', command: 'claude', platform: 'darwin' }),
  )
})

check('windows draft launcher pre-fills an unsent prompt from a file', () => {
  const script = buildWindowsDraftLauncherScript({
    cwd: "C:\\Users\\O'Brien\\repo",
    title: 'Triage Desk: acme/widgets #288',
    agentCommand: 'claude {prompt}',
    promptFile: 'C:\\Temp\\triage-desk\\prompt.txt',
    draftFlag: '--prefill',
  })
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\Users\\O''Brien\\repo'"))
  assert.ok(script.includes("$Host.UI.RawUI.WindowTitle = 'Triage Desk: acme/widgets #288'"))
  assert.ok(script.includes("$prompt = Get-Content -Raw -LiteralPath 'C:\\Temp\\triage-desk\\prompt.txt'"))
  assert.ok(script.includes("& 'claude' '--prefill' $prompt"))
  assert.ok(script.includes('$LASTEXITCODE'))
  assert.ok(!script.includes('{prompt}'))
  assert.ok(!script.includes('https://github.com/'), 'the prompt text must stay out of the script')
  const opencode = buildWindowsDraftLauncherScript({
    cwd: 'C:\\repo',
    title: 't',
    agentCommand: 'opencode {prompt}',
    promptFile: 'C:\\Temp\\prompt.txt',
    draftFlag: '--prompt',
  })
  assert.ok(opencode.includes("& 'opencode' '--prompt' $prompt"))
  const staticArgs = buildWindowsDraftLauncherScript({
    cwd: 'C:\\repo',
    title: 't',
    agentCommand: 'my-agent --model=opus {prompt}',
    promptFile: 'C:\\Temp\\prompt.txt',
    draftFlag: '--prefill',
  })
  assert.ok(staticArgs.includes("& 'my-agent' '--model=opus' '--prefill' $prompt"))
})

check('Windows draft reads the UTF-8 prompt explicitly instead of the ANSI default', () => {
  const script = buildWindowsDraftLauncherScript({
    cwd: 'C:\\工作', title: '检查', agentCommand: 'claude {prompt}',
    promptFile: 'C:\\Temp\\prompt.txt', draftFlag: '--prefill',
  })
  assert.match(script, /Get-Content[^\n]*-Encoding UTF8/)
})

check('windows clipboard launcher runs the bare agent and prints a hint', () => {
  const script = buildWindowsClipboardLauncherScript({
    cwd: 'C:\\repo',
    title: 'Triage Desk: repo',
    bareCommand: 'my-agent --flag',
  })
  assert.ok(script.includes("Set-Location -LiteralPath 'C:\\repo'"))
  assert.ok(script.includes("& 'my-agent' '--flag'"))
  assert.ok(script.includes('Write-Host'))
  assert.ok(script.toLowerCase().includes('clipboard'))
  assert.ok(script.includes('$LASTEXITCODE'))
  assert.ok(!script.includes('Get-Content'), 'clipboard mode needs no prompt file')
  assert.ok(!script.includes('{prompt}'))
})

check('windows login launcher runs gh auth login and prints hints', () => {
  const script = buildWindowsLoginLauncherScript({
    cwd: 'C:\\workspace',
    ghCommand: 'C:\\Program Files\\GitHub CLI\\gh.exe',
  })
  assert.ok(
    script.includes(
      "& 'C:\\Program Files\\GitHub CLI\\gh.exe' 'auth' 'login' '--hostname' 'github.com' '--git-protocol' 'https' '--web'",
    ),
  )
  assert.ok(script.includes('Write-Host'))
  assert.ok(script.includes('Check connection'))
  assert.ok(script.includes('$LASTEXITCODE'))
})

check('terminal opener plan opens a macOS Terminal window without iTerm2', () => {
  const scriptPath = "/tmp/it's a launch.command"
  assert.deepEqual(openTerminalPlan('darwin', { scriptPath }), {
    argv: ['/usr/bin/open', '-a', 'Terminal', scriptPath],
    variant: 'window',
  })
  assert.deepEqual(openTerminalPlan('darwin', { scriptPath: '/tmp/launch.command', tab: false }), {
    argv: ['/usr/bin/open', '-a', 'Terminal', '/tmp/launch.command'],
    variant: 'window',
  })
})

check('terminal opener plan opens an iTerm2 tab when iTerm2 is present', () => {
  const scriptPath = "/tmp/it's a launch.command"
  const plan = openTerminalPlan('darwin', { scriptPath, iterm: true })
  assert.equal(plan.variant, 'tab')
  assert.deepEqual(plan.argv.slice(0, 2), ['/usr/bin/osascript', '-e'])
  const script = plan.argv[2]
  assert.ok(script.includes('tell application "iTerm"'), 'addresses iTerm')
  assert.ok(script.includes('create tab with default profile command'), 'creates a tab')
  assert.ok(script.includes('create window with default profile command'), 'opens a window when none exist')
  // the path is shell-quoted inside the AppleScript string: a literal single
  // quote becomes '\'' for the shell, and AppleScript then escapes the
  // backslash, so the embedded form is '\\''.
  assert.ok(script.includes("'/tmp/it'\\\\''s a launch.command'"), 'shell-quotes the path')
  // a window fallback still routes to Terminal.app (iTerm has no tab request)
  assert.deepEqual(openTerminalPlan('darwin', { scriptPath, iterm: true, tab: false }), {
    argv: ['/usr/bin/open', '-a', 'Terminal', scriptPath],
    variant: 'window',
  })
  assert.throws(() => buildItermTabAppleScript(''), /launcher script path/)
  assert.throws(() => buildItermTabAppleScript('/tmp/a\nb'), /launcher script path/)
})

check('focus plan raises an existing tab only when the platform can', () => {
  const title = 'Triage Desk: Review — acme/widgets #288 [Claude Code]'
  // macOS: iTerm2 only; Terminal.app has no safe lookup.
  const mac = focusTerminalPlan('darwin', { title, iterm: true })
  assert.ok(mac !== null, 'iTerm2 focus plan exists')
  assert.deepEqual(mac.argv.slice(0, 2), ['/usr/bin/osascript', '-e'])
  assert.ok(mac.argv[2].includes('name of s contains "' + title + '"'), 'matches the tab by title')
  assert.ok(mac.argv[2].includes('return matched'), 'reports whether it matched')
  assert.equal(focusTerminalPlan('darwin', { title }), null, 'Terminal.app cannot focus by title')
  // Windows: no reliable per-tab focus by title.
  assert.equal(focusTerminalPlan('win32', { title, wt: 'wt' }), null)
  // Linux: wmctrl preferred, xdotool next, else null.
  assert.deepEqual(focusTerminalPlan('linux', { title, wmctrl: '/usr/bin/wmctrl' }), {
    argv: ['/usr/bin/wmctrl', '-a', title],
  })
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.notEqual(escapedTitle, title, 'the title contains regexp metacharacters')
  assert.ok(escapedTitle.includes('\\[Claude Code\\]'), 'brackets are escaped for xdotool')
  assert.deepEqual(focusTerminalPlan('linux', { title, xdotool: '/usr/bin/xdotool' }), {
    argv: ['/usr/bin/xdotool', 'search', '--name', escapedTitle, 'windowactivate'],
  })
  assert.equal(focusTerminalPlan('linux', { title }), null, 'no raiser installed')
  assert.equal(focusTerminalPlan('darwin', { iterm: true }), null, 'no title means no focus')
})

check('terminal opener plan uses Windows Terminal tabs and a cmd fallback', () => {
  const scriptPath = 'C:\\Temp\\triage-desk\\launch.ps1'
  const wtPath = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe'
  const tab = openTerminalPlan('win32', { scriptPath, title: 'Triage Desk: repo', wt: wtPath })
  assert.equal(tab.variant, 'tab')
  assert.deepEqual(tab.argv, [
    wtPath,
    '-w',
    '0',
    'new-tab',
    '--title',
    'Triage Desk: repo',
    'powershell.exe',
    '-NoExit',
    '-NoLogo',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
  ])
  const window = openTerminalPlan('win32', { scriptPath, title: 'Triage Desk: repo', wt: wtPath, tab: false })
  assert.equal(window.variant, 'window')
  assert.deepEqual(window.argv.slice(0, 6), [wtPath, '-w', '-1', 'new-tab', '--title', 'Triage Desk: repo'])
  const cmd = openTerminalPlan('win32', { scriptPath, title: 'Triage Desk: repo' })
  assert.equal(cmd.variant, 'window')
  assert.deepEqual(cmd.argv.slice(0, 4), ['cmd.exe', '/c', 'start', ''])
  assert.equal(cmd.argv[cmd.argv.length - 1], scriptPath)
})

check('terminal opener plan covers the linux terminal emulators', () => {
  const scriptPath = '/tmp/launch.command'
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/gnome-terminal' }), {
    argv: ['/usr/bin/gnome-terminal', '--tab', '--', 'sh', scriptPath],
    variant: 'tab',
  })
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/gnome-terminal', shell: '/bin/bash' }), {
    argv: ['/usr/bin/gnome-terminal', '--tab', '--', '/bin/bash', scriptPath],
    variant: 'tab',
  })
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/gnome-terminal', tab: false }), {
    argv: ['/usr/bin/gnome-terminal', '--window', '--', 'sh', scriptPath],
    variant: 'window',
  })
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/konsole' }), {
    argv: ['/usr/bin/konsole', '--new-tab', '-e', scriptPath],
    variant: 'tab',
  })
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/xfce4-terminal' }), {
    argv: ['/usr/bin/xfce4-terminal', '--tab', '-x', scriptPath],
    variant: 'tab',
  })
  assert.deepEqual(openTerminalPlan('linux', { scriptPath, terminal: '/usr/bin/xterm' }), {
    argv: ['/usr/bin/xterm', '-e', scriptPath],
    variant: 'window',
  })
  assert.throws(() => openTerminalPlan('linux', { scriptPath }), /no terminal emulator/)
  assert.throws(() => openTerminalPlan('plan9', { scriptPath }), /unsupported platform/)
})

await checkAsync('clone discovery finds configured clones and skips heavy dirs', async () => {
  const result = await scanCloneDirs([path.join(fixture, 'Playground'), missingDir])
  const repos = result.clones.map((clone) => clone.repo).sort()
  assert.deepEqual(repos, ['acme/relay', 'acme/widgets'])
  assert.equal(result.clones.find((clone) => clone.repo === 'acme/widgets').path, cloneA)
  assert.ok(result.skipped.some((entry) => entry.path === missingDir))
})

await checkAsync('fork clones match both origin and upstream repositories', async () => {
  const fork = path.join(fixture, 'fork')
  await fs.mkdir(path.join(fork, '.git'), { recursive: true })
  await fs.writeFile(path.join(fork, '.git', 'config'),
    '[remote "origin"]\n url = git@github.com:contributor/project.git\n'
    + '[remote "upstream"]\n url = https://github.com/team/project.git\n')
  const result = await scanCloneDirs([fork])
  assert.equal(matchClone(result.clones, 'contributor/project')?.path, fork)
  assert.equal(matchClone(result.clones, 'TEAM/PROJECT')?.path, fork)
})

await checkAsync('every clone root gets its own folder budget', async () => {
  const result = await scanCloneDirs([cloneA, cloneB], { limit: 1 })
  assert.equal(matchClone(result.clones, 'acme/widgets')?.path, cloneA)
  assert.equal(matchClone(result.clones, 'acme/relay')?.path, cloneB)
})

await checkAsync('clone matching is case-insensitive and ordered', async () => {
  const result = await scanCloneDirs([path.join(fixture, 'Playground')])
  assert.equal(matchClone(result.clones, 'acme/relay').path, cloneB)
  assert.equal(matchClone(result.clones, 'acme/unknown'), null)
})

await checkAsync('clone roots are discovered without hard-coded names', async () => {
  const home = path.join(fixture, 'home')
  const projectRoot = path.join(home, 'Playground')
  const directClone = path.join(home, 'direct-clone')
  await fs.mkdir(path.join(projectRoot, 'demo', '.git'), { recursive: true })
  await fs.mkdir(path.join(directClone, '.git'), { recursive: true })
  await fs.mkdir(path.join(home, '.cache', 'hidden', '.git'), { recursive: true })
  await fs.mkdir(path.join(home, 'Documents', 'nested', 'deep', 'repo', '.git'), { recursive: true })
  const roots = await discoverCloneRoots(home)
  assert.ok(roots.includes(projectRoot), 'project root with clone children')
  assert.ok(roots.includes(directClone), 'directory that is itself a clone')
  assert.ok(!roots.some((root) => root.includes('.cache')), 'hidden dirs are skipped')
  assert.ok(!roots.some((root) => root.includes('Documents')), 'deep nested clones do not promote a root')
})

/** Fake login-shell probe output in the buildExecutableProbe format. */
function probeOutput(names, locate, commandV = locate) {
  return names.map((name) => ['__td__', name, locate(name), commandV(name)].join('\t')).join('\n') + '\n'
}

// Exercise real registered routes, replacing only OS boundaries. In particular,
// startup cleanup cannot remove real temp directories and no opener can run.
async function withPlatformHost(platform, spawn, callback, config = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const savedFs = {}
  const files = new Map()
  const routes = new Map()
  const fakeFs = {
    readdir: async () => [],
    stat: async () => ({ isDirectory: () => true, isFile: () => false, mtimeMs: Date.now() }),
    access: async () => {},
    mkdtemp: async (prefix) => prefix + 'offline-fixture',
    realpath: async (file) => file,
    writeFile: async (file, text) => { files.set(file, Buffer.from(text, 'utf8')) },
    chmod: async () => {},
    rm: async () => {},
  }
  for (const [name, replacement] of Object.entries(fakeFs)) {
    savedFs[name] = fs[name]
    fs[name] = replacement
  }
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  const handle = (code = 0, stdout = '', stderr = '') => ({
    done: Promise.resolve({ exitCode: code }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout }) },
      stderr: { readFrom: () => ({ text: stderr }) },
    },
    terminate() { throw new Error('unexpected termination') },
  })
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => fn(),
    webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
    connection: { requestRejection: () => undefined },
    subprocess: {
      spawn: (spec) => spawn(spec, handle),
      resolveExecutable: async (name) => name,
    },
    tools: { register() {} },
    systemPrompt: { section() {} },
    get: () => undefined,
  }
  try {
    apply(ctx, {
      cwd: '/offline/工作',
      cloneDirs: ['/offline/工作'],
      repoPaths: { 'acme/widgets': '/offline/工作' },
      ...config,
    })
    const request = async (routePath, method = 'GET', body) => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
      Object.assign(req, { method, url: routePath, headers: {} })
      const res = { statusCode: 0, body: '', setHeader() {}, end(text) { this.body = text || '' } }
      await routes.get(routePath).handler(req, res)
      return { status: res.statusCode, body: JSON.parse(res.body) }
    }
    await callback({ request, files })
  } finally {
    Object.assign(fs, savedFs)
    Object.defineProperty(process, 'platform', descriptor)
  }
}

await checkAsync('host detection retains an entire quoted executable path', async () => {
  await withPlatformHost('darwin', () => { throw new Error('an absolute executable must not need a PATH probe') }, async ({ request }) => {
    const config = await request('/triage-desk/config')
    assert.equal(config.status, 200)
    assert.deepEqual(config.body.config.detectedAgents.custom, { available: true, path: '/offline/Agent Tools/claude', executable: '/offline/Agent Tools/claude' })
  }, {
    agents: [{ id: 'custom', label: 'Custom', command: '"/offline/Agent Tools/claude" {prompt}' }],
    defaultAgent: 'custom',
  })
})

await checkAsync('macOS detection reads PATH configured only in the user zshrc', async () => {
  // Real zsh, isolated HOME/ZDOTDIR: never source or alter the user's profile.
  // Other platforms still check the route's subprocess contract offline.
  const shellHome = path.join(fixture, 'shell-home')
  const bin = path.join(shellHome, 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  await fs.writeFile(path.join(shellHome, '.zshrc'), 'export PATH=' + shellQuote(bin) + ':$PATH\n')
  const nativeZsh = process.platform === 'darwin'
  await withPlatformHost('darwin', (spec, handle) => {
    assert.equal(spec.argv[0], '/bin/zsh')
    if (nativeZsh) {
      const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
        env: { HOME: shellHome, ZDOTDIR: shellHome, PATH: '/usr/bin:/bin', TERM: 'dumb' },
        encoding: 'utf8', timeout: 3000,
      })
      return handle(result.status, result.stdout, result.stderr)
    }
    const interactive = spec.argv[1].includes('i')
    return handle(0, probeOutput(spec.argv.slice(4), (name) => (interactive && name === 'claude' ? bin + '/claude' : '')))
  }, async ({ request }) => {
    const config = await request('/triage-desk/config')
    assert.equal(config.status, 200)
    assert.equal(config.body.config.detectedAgents.claude.available, true)
    assert.equal(config.body.config.detectedAgents.claude.path, bin + '/claude')
    const discovered = await request('/triage-desk/agents/find', 'POST', {})
    assert.equal(discovered.status, 200)
    assert.ok(discovered.body.found.some((agent) => agent.id === 'claude' && agent.path === bin + '/claude'))
  })
})

await checkAsync('Linux launch acknowledges a long-lived emulator without killing it', async () => {
  const nativeTimeout = globalThis.setTimeout
  const oldTerminal = process.env.TERMINAL
  let terminated = 0
  let opened = 0
  // Compress command timeouts, not startup observation; no 20-second test wait.
  globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms >= 1000 ? 10 : ms, ...args)
  process.env.TERMINAL = '/usr/bin/xterm'
  try {
    await withPlatformHost('linux', (spec, handle) => {
      if (spec.argv[0] === '/usr/bin/xterm') {
        opened += 1
        let finish
        return {
          done: new Promise((resolve) => { finish = resolve }),
          terminate() { terminated += 1; finish({ exitCode: 124 }) },
        }
      }
      if (spec.argv[3] === 'triage-desk') return handle(0, probeOutput(spec.argv.slice(4), (name) => '/usr/bin/' + name))
      if (spec.argv[0] === 'wl-copy') return handle()
      throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
    }, async ({ request }) => {
      const result = await request('/triage-desk/launch', 'POST', { url: PR_URL })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      await new Promise((resolve) => nativeTimeout(resolve, 25))
      assert.equal(terminated, 0, 'a healthy interactive terminal must outlive the request')
      assert.equal(opened, 1)
    })
  } finally {
    globalThis.setTimeout = nativeTimeout
    if (oldTerminal === undefined) delete process.env.TERMINAL
    else process.env.TERMINAL = oldTerminal
  }
})

await checkAsync('Linux launch reports immediate errors and retries a failed tab as a window', async () => {
  const oldTerminal = process.env.TERMINAL
  process.env.TERMINAL = '/usr/bin/gnome-terminal'
  try {
    for (const windowSucceeds of [false, true]) {
      const attempts = []
      await withPlatformHost('linux', (spec, handle) => {
        if (spec.argv[0] === '/usr/bin/gnome-terminal') {
          attempts.push(spec.argv[1])
          return handle(windowSucceeds && spec.argv[1] === '--window' ? 0 : 1, '', 'cannot open display')
        }
        if (spec.argv[3] === 'triage-desk') return handle(0, probeOutput(spec.argv.slice(4), (name) => '/usr/bin/' + name))
        if (spec.argv[0] === 'wl-copy') return handle()
        throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
      }, async ({ request }) => {
        const result = await request('/triage-desk/launch', 'POST', { url: PR_URL })
        assert.equal(result.status, windowSucceeds ? 200 : 502, JSON.stringify(result.body))
        assert.deepEqual(attempts, ['--tab', '--window'])
        if (!windowSucceeds) assert.match(result.body.error.message, /cannot open display/)
      })
    }
  } finally {
    if (oldTerminal === undefined) delete process.env.TERMINAL
    else process.env.TERMINAL = oldTerminal
  }
})

await checkAsync('Windows draft, clipboard and login routes write UTF-8 BOM scripts', async () => {
  await withPlatformHost('win32', (spec, handle) => {
    if (spec.argv[0] === 'powershell.exe') return handle(0, '__td__\tclaude\tC:\\bin\\claude.exe\t\n__td__\tcodex\tC:\\bin\\codex.exe\t\n')
    if (spec.argv.includes('auth')) return handle(1, '', 'not logged in')
    if (spec.argv[0] === 'clip.exe' || spec.argv[0] === 'wt') return handle()
    throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
  }, async ({ request, files }) => {
    for (const agent of ['claude', 'codex']) {
      const result = await request('/triage-desk/launch', 'POST', { url: PR_URL, agent })
      assert.equal(result.status, 200, JSON.stringify(result.body))
      const script = [...files.entries()].find(([file]) => file.endsWith('launch.ps1'))?.[1]
      assert.ok(script, agent + ' script was written')
      assert.equal(script.subarray(0, 3).toString('hex'), 'efbbbf', agent + ' script must identify UTF-8 to PowerShell 5.1')
      assert.ok(script.toString('utf8').includes('/offline/工作'))
    }
    const login = await request('/triage-desk/auth/login', 'POST', {})
    assert.equal(login.status, 200, JSON.stringify(login.body))
    const script = [...files.entries()].find(([file]) => file.endsWith('login.ps1'))?.[1]
    assert.ok(script, 'login script was written')
    assert.equal(script.subarray(0, 3).toString('hex'), 'efbbbf')
  })
})

await checkAsync('macOS launch opens an iTerm2 tab and reuses it on re-launch', async () => {
  // The fixture fs.stat reports every directory as present, so detectIterm sees
  // iTerm2 installed and the launch takes the tab path. An absolute agent
  // command skips the login-shell probe, keeping the subprocess set to osascript.
  let openTabs = 0
  let focusProbes = 0
  let terminalActivations = 0
  let tabExists = false
  await withPlatformHost('darwin', (spec, handle) => {
    if (spec.argv[0] === '/usr/bin/osascript') {
      const script = spec.argv[2] || ''
      if (script.includes('return matched')) {
        focusProbes += 1
        // report whether a matching tab is already open
        return handle(0, tabExists ? 'true' : 'false')
      }
      if (script.includes('create tab') || script.includes('create window')) {
        openTabs += 1
        tabExists = true
        return handle(0)
      }
      throw new Error('unexpected osascript: ' + script)
    }
    if (spec.argv[0] === '/usr/bin/open' && spec.argv[1] === '-a' && spec.argv[2] === 'Terminal') {
      terminalActivations += 1
      return handle(0)
    }
    throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
  }, async ({ request }) => {
    const first = await request('/triage-desk/launch', 'POST', { url: PR_URL })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(focusProbes, 1, 'first launch probes for an existing tab')
    assert.equal(openTabs, 1, 'first launch opens a tab')
    assert.equal(terminalActivations, 0, 'iTerm2 plans activate themselves, not Terminal.app')

    const second = await request('/triage-desk/launch', 'POST', { url: PR_URL })
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(focusProbes, 2, 'second launch probes again')
    assert.equal(openTabs, 1, 're-launching the same agent+item focuses, not duplicates')
  }, {
    agents: [{ id: 'claude', label: 'Claude Code', command: '/offline/bin/claude {prompt}' }],
    defaultAgent: 'claude',
  })
})

/* ------------------------------------------------------------------------ */
/* Agent command rule (shared with the client editor)                        */
/* ------------------------------------------------------------------------ */

const AGENT_RULE_CASES = {
  accept: [
    'claude {prompt}',
    'opencode --prompt {prompt}',
    'aider --message={prompt}',
    'FOO=1 codex {prompt}',
    'FOO="a b" codex {prompt}',
    '/opt/x/claude --flag {prompt}',
    'npx -y @scope/agent {prompt}',
  ],
  reject: [
    '{prompt}',
    'FOO=1 {prompt}',
    'claude "{prompt}"',
    "claude '{prompt}'",
    'claude --message="{prompt}"',
    'claude {prompt} {prompt}',
    'claude {prompt}; rm -rf ~',
    'claude $(echo) {prompt}',
    'claude `x` {prompt}',
    'claude x{prompt}',
    'claude {prompt}x',
    'claude {prompt} | tee',
    'claude --m={prompt}=x',
    'claude {prompt} # x',
  ],
}

for (const command of AGENT_RULE_CASES.accept) {
  check('agent rule accepts ' + command, () => {
    assert.equal(hasSafePromptPlaceholder(command), true)
    const config = normalizeLauncherConfig({ agents: [{ id: 'case', label: 'Case', command }] })
    assert.deepEqual(config.agents.map((agent) => agent.command), [command])
    assert.deepEqual(config.invalidAgents, [])
    assert.ok(typeof bareAgentCommand(command, 'linux') === 'string')
  })
}

for (const command of AGENT_RULE_CASES.reject) {
  check('agent rule rejects ' + command, () => {
    assert.equal(hasSafePromptPlaceholder(command), false)
    const config = normalizeLauncherConfig({ agents: [{ id: 'case', label: 'Case', command }] })
    assert.deepEqual(config.invalidAgents, [{ id: 'case', label: 'Case', command, reason: 'placeholder' }])
    assert.equal(config.agents.some((agent) => agent.id === 'case'), false)
    assert.throws(() => buildDraftCommand(command, 'x', '--prefill'), /\{prompt\}/)
    assert.throws(() => bareAgentCommand(command, 'linux'), /\{prompt\}/)
  })
}

check('saved agents that break the rule are reported, valid ones kept', () => {
  const mixed = normalizeLauncherConfig({
    agents: [
      { id: 'old', label: 'Old quoted', command: 'claude "{prompt}"' },
      { id: 'fine', label: 'Fine', command: 'codex {prompt}' },
    ],
    defaultAgent: 'old',
  })
  assert.deepEqual(mixed.agents.map((agent) => agent.id), ['fine'])
  assert.equal(mixed.defaultAgent, 'fine')
  assert.deepEqual(mixed.invalidAgents, [{ id: 'old', label: 'Old quoted', command: 'claude "{prompt}"', reason: 'placeholder' }])
  const allInvalid = normalizeLauncherConfig({ agents: [{ id: 'old', label: 'Old', command: "claude '{prompt}'" }] })
  assert.deepEqual(allInvalid.agents.map((agent) => agent.id), AGENT_PRESETS.map((agent) => agent.id), 'presets fallback')
  assert.equal(allInvalid.invalidAgents.length, 1, 'the fallback still reports the rejected agent')
})

check('--flag={prompt} stays one literal argument in real /bin/sh', () => {
  const prompt = '$(printf INJECTED) `printf BACKTICK` "double" single\'quote \\ ${HOME} ; | &'
  const template = 'printf "<%s>\\n" --message={prompt} tail'
  const command = buildDraftCommand(template, prompt, '--prefill')
  const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '<--prefill>\n<--message=' + prompt + '>\n<tail>\n', command)
})

check('clipboard mode drops the whole --flag={prompt} word', () => {
  assert.equal(bareAgentCommand('aider --message={prompt}', 'linux'), 'aider')
  assert.equal(bareAgentCommand('aider -m={prompt} --yes', 'win32'), 'aider --yes')
})

check('Windows draft passes --flag= and the prompt as one expression argument', () => {
  const script = buildWindowsDraftLauncherScript({
    cwd: 'C:\\work', title: 't', agentCommand: 'aider --model=x --message={prompt}', promptFile: 'C:\\p.txt', draftFlag: '--prefill',
  })
  assert.ok(script.includes("& 'aider' '--model=x' '--prefill' ('--message=' + $prompt)"), script)
  // PS 5.1 does not escape embedded quotes for native commands: the script does.
  const escape = "$prompt = $prompt -replace '(\\\\*)\"', '$1$1\\\"'"
  assert.ok(script.includes(escape + '\n& '), script)
  assert.ok(script.indexOf(escape) > script.indexOf('Get-Content'))
})

check('the detected executable is pinned without breaking the rule', () => {
  assert.equal(withAgentExecutable('claude {prompt}', '/opt/x/claude'), '/opt/x/claude {prompt}')
  assert.equal(withAgentExecutable('FOO="a b" claude --x {prompt}', '/opt/a b/claude'), 'FOO="a b" \'/opt/a b/claude\' --x {prompt}')
  assert.equal(withAgentExecutable('/usr/local/bin/claude {prompt}', '/opt/x/claude'), '/usr/local/bin/claude {prompt}')
  assert.equal(withAgentExecutable('claude {prompt}', 'relative/claude'), 'claude {prompt}')
  assert.equal(withAgentExecutable('claude {prompt}', '/opt/$(x)/claude'), 'claude {prompt}', 'never pin into a rejected command')
})

check('POSIX launchers add the agent directory to PATH only when missing', () => {
  const script = buildClipboardLauncherScript({ cwd: '/tmp', title: 't', bareCommand: 'agent', binDir: "/opt/it's dir", platform: 'linux' })
  const guard = script.split('\n').find((line) => line.startsWith('case '))
  assert.ok(guard, script)
  assert.ok(script.indexOf(guard) < script.indexOf('\nagent\n'))
  for (const [shell, PATH, expected] of [
    ['/bin/sh', '/usr/bin:/bin', "/opt/it's dir:/usr/bin:/bin"],
    ['/bin/sh', "/x:/opt/it's dir:/usr/bin", "/x:/opt/it's dir:/usr/bin"],
    ['/bin/sh', '', "/opt/it's dir"],
  ]) {
    const result = spawnSync(shell, ['-c', guard + '\nprintf "%s" "$PATH"'], { env: { PATH }, encoding: 'utf8' })
    assert.equal(result.stdout, expected, PATH)
  }
  assert.equal(buildDraftLauncherScript({ cwd: '/tmp', title: 't', command: 'x' }).includes('case '), false, 'no binDir, no PATH line')
})

/* ------------------------------------------------------------------------ */
/* Agent detection probe                                                     */
/* ------------------------------------------------------------------------ */

check('probe answers: only absolute paths launch; aliases and functions are reported', () => {
  const cases = [
    [{ located: '/usr/bin/claude', commandV: '/usr/bin/claude' }, { path: '/usr/bin/claude' }],
    [{ located: '', commandV: 'alias claude=/opt/x/claude' }, { path: '/opt/x/claude', via: 'alias' }],
    [{ located: '', commandV: "alias claude='/opt/x/claude'" }, { path: '/opt/x/claude', via: 'alias' }],
    [{ located: '/usr/bin/claude', commandV: "alias claude='claude --verbose'" }, { path: '/usr/bin/claude' }],
    [{ located: '', commandV: "alias claude='/opt/sp ace/claude'" }, { path: null, reason: 'alias' }],
    [{ located: '', commandV: "alias claude='noglob claude'" }, { path: null, reason: 'alias' }],
    [{ located: '', commandV: 'claude' }, { path: null, reason: 'function' }],
    [{ located: '', commandV: '' }, { path: null, reason: 'missing' }],
    [{ located: '', commandV: '/usr/local/bin/claude' }, { path: '/usr/local/bin/claude' }],
  ]
  for (const [answer, expected] of cases) assert.deepEqual(classifyProbeAnswer(answer, 'darwin'), expected, JSON.stringify(answer))
  assert.deepEqual(classifyProbeAnswer({ located: 'C:\\bin\\claude.exe', commandV: '' }, 'win32'), { path: 'C:\\bin\\claude.exe' })
  const parsed = parseExecutableProbe('noise\twith tab\n__td__\tclaude\t/usr/bin/claude\t/usr/bin/claude\n__td__\tfn\t\tfn\n')
  assert.deepEqual([...parsed.keys()], ['claude', 'fn'])
  assert.deepEqual(buildExecutableProbe('/bin/zsh', ['a']).slice(0, 2), ['/bin/zsh', '-lic'])
  assert.deepEqual(buildExecutableProbe('/bin/bash', ['a']).slice(0, 2), ['/bin/bash', '-lic'])
  assert.deepEqual(buildExecutableProbe('/bin/dash', ['a']).slice(0, 2), ['/bin/dash', '-lc'])
  assert.deepEqual(buildExecutableProbe('/bin/dash', ['a']).slice(3), ['triage-desk', 'a'])
})

await checkAsync('the probe classifies aliases, functions and rc noise in real shells', async () => {
  // Real shells with an isolated HOME/ZDOTDIR; stdin is closed as in the host.
  const home = path.join(fixture, 'probe-home')
  await fs.mkdir(path.join(home, 'bin'), { recursive: true })
  await fs.mkdir(path.join(home, 'opt'), { recursive: true })
  for (const file of ['bin/real', 'opt/aliased']) {
    await fs.writeFile(path.join(home, file), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  }
  const rc = [
    "echo 'rc noise\twith a tab'",
    'export PATH=' + shellQuote(path.join(home, 'bin')) + ':$PATH',
    'alias aliased=' + shellQuote(path.join(home, 'opt', 'aliased')),
    "alias complex='real --verbose'",
    'fn() { :; }',
    "alias printf='echo HIJACKED'",
    "alias command='echo HIJACKED'",
    '',
  ].join('\n')
  await fs.writeFile(path.join(home, '.zshrc'), rc)
  // Debian/Ubuntu layout: the login profile sources ~/.bashrc, which returns
  // early for non-interactive shells before the PATH and alias lines.
  await fs.writeFile(path.join(home, '.bash_profile'), '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n')
  await fs.writeFile(path.join(home, '.bashrc'), 'case $- in *i*) ;; *) return;; esac\n' + rc + "alias type='echo HIJACKED'\n")
  const names = ['real', 'aliased', 'complex', 'fn', 'missing']
  for (const shell of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    try {
      await fs.access(shell)
    } catch {
      continue
    }
    const argv = buildExecutableProbe(shell, names)
    const result = spawnSync(argv[0], argv.slice(1), {
      env: { HOME: home, ZDOTDIR: home, PATH: '/usr/bin:/bin', TERM: 'dumb' },
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    })
    assert.equal(result.status, 0, shell + ': ' + result.stderr)
    const verdicts = Object.fromEntries([...parseExecutableProbe(result.stdout)].map(([name, answer]) => [name, classifyProbeAnswer(answer, 'darwin')]))
    assert.deepEqual(Object.keys(verdicts), names, shell)
    assert.equal(verdicts.missing.reason, 'missing', shell)
    if (shell === '/bin/sh') continue // POSIX sh -lc reads no rc file used here
    assert.equal(verdicts.real.path, path.join(home, 'bin', 'real'), shell)
    assert.deepEqual(verdicts.aliased, { path: path.join(home, 'opt', 'aliased'), via: 'alias' }, shell)
    assert.deepEqual(verdicts.complex, { path: null, reason: 'alias' }, shell)
    assert.deepEqual(verdicts.fn, { path: null, reason: 'function' }, shell)
  }
})

await checkAsync('detection reports aliases/functions and launch pins the detected binary', async () => {
  const oldTerminal = process.env.TERMINAL
  process.env.TERMINAL = '/usr/bin/xterm'
  try {
    await withPlatformHost('linux', (spec, handle) => {
      if (spec.argv[3] === 'triage-desk') {
        return handle(0, probeOutput(spec.argv.slice(4), () => '', (name) => ({
          claude: 'alias claude=/home/me/.nvm/versions/node/v22/bin/claude',
          codex: 'codex',
          gemini: "alias gemini='gemini --yolo'",
        })[name] || ''))
      }
      if (spec.argv[0] === '/usr/bin/xterm') {
        assert.deepEqual(spec.stdio.stderr, { maxBytes: 16 * 1024 }, 'a bounded collector, never an unread pipe')
        return { done: new Promise(() => {}), terminate() {} }
      }
      if (spec.argv[0] === 'wl-copy') return handle()
      throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
    }, async ({ request, files }) => {
      const config = await request('/triage-desk/config')
      const detected = config.body.config.detectedAgents
      assert.deepEqual(detected.claude, { available: true, path: '/home/me/.nvm/versions/node/v22/bin/claude', executable: 'claude' })
      assert.deepEqual(detected.codex, { available: false, path: null, reason: 'function', executable: 'codex' })
      assert.deepEqual(detected.gemini, { available: false, path: null, reason: 'alias', executable: 'gemini' })
      assert.deepEqual(config.body.config.invalidAgents, [])
      const blocked = await request('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'codex' })
      assert.equal(blocked.status, 400)
      assert.equal(blocked.body.error.code, 'agent-missing')
      assert.equal(blocked.body.error.reason, 'function')
      assert.match(blocked.body.error.message, /shell function/)
      const launched = await request('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'claude' })
      assert.equal(launched.status, 200, JSON.stringify(launched.body))
      const script = [...files.entries()].find(([file]) => file.endsWith('launch.command'))[1].toString('utf8')
      assert.ok(script.includes("/home/me/.nvm/versions/node/v22/bin/claude --prefill '"), script)
      assert.ok(script.includes("case \":$PATH:\" in *:'/home/me/.nvm/versions/node/v22/bin':*)"), script)
    })
  } finally {
    if (oldTerminal === undefined) delete process.env.TERMINAL
    else process.env.TERMINAL = oldTerminal
  }
})

await checkAsync('a bash login shell is probed interactively and its job-control noise is tolerated', async () => {
  const oldShell = process.env.SHELL
  process.env.SHELL = '/bin/bash'
  const probes = []
  try {
    await withPlatformHost('linux', (spec, handle) => {
      if (spec.argv[3] === 'triage-desk') {
        probes.push(spec.argv.slice(0, 2))
        assert.equal(spec.stdio.stdin, 'ignore')
        return handle(0, 'rc noise\n' + probeOutput(spec.argv.slice(4), (name) => '/home/me/.nvm/bin/' + name),
          'bash: cannot set terminal process group (1): Inappropriate ioctl for device\nbash: no job control in this shell\n')
      }
      throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
    }, async ({ request }) => {
      const config = await request('/triage-desk/config')
      assert.deepEqual(config.body.config.detectedAgents.claude, { available: true, path: '/home/me/.nvm/bin/claude', executable: 'claude' })
    })
    assert.deepEqual(probes, [['/bin/bash', '-lic']])
  } finally {
    if (oldShell === undefined) delete process.env.SHELL
    else process.env.SHELL = oldShell
  }
})

await checkAsync('saved invalid agents reach publicConfig and explain a pinned scenario', async () => {
  await withPlatformHost('darwin', (spec, handle) => {
    if (spec.argv[3] === 'triage-desk') return handle(0, probeOutput(spec.argv.slice(4), (name) => '/usr/bin/' + name))
    throw new Error('unexpected subprocess: ' + spec.argv.join(' '))
  }, async ({ request }) => {
    const config = await request('/triage-desk/config')
    assert.deepEqual(config.body.config.invalidAgents, [
      { id: 'legacy', label: 'Legacy', command: 'claude --message="{prompt}"', reason: 'placeholder' },
    ])
    assert.deepEqual(config.body.config.agents.map((agent) => agent.id), ['codex'])
    const launch = await request('/triage-desk/launch', 'POST', { url: PR_URL, agent: 'legacy' })
    assert.equal(launch.status, 400)
    assert.equal(launch.body.error.code, 'unknown-agent')
    assert.match(launch.body.error.message, /disabled because/)
  }, {
    agents: [
      { id: 'legacy', label: 'Legacy', command: 'claude --message="{prompt}"' },
      { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
    ],
  })
})

/* ------------------------------------------------------------------------ */
/* Clone search                                                              */
/* ------------------------------------------------------------------------ */

check('ssh config aliases resolve only to GitHub hostnames', () => {
  const aliases = parseSshConfigHosts([
    '# work account',
    'Host github-work gh-alt',
    '  HostName github.com',
    '  IdentityFile ~/.ssh/work',
    'Host=gh443',
    '  hostname = "ssh.github.com"',
    'Host gh-token',
    '  HostName %h.example.com',
    'Host *.corp github-*',
    '  HostName github.com',
    'Host gitlab-work',
    '  HostName gitlab.com',
    'Host first-wins',
    '  HostName gitlab.com',
    'Host first-wins',
    '  HostName github.com',
    'Match host matched',
    '  HostName github.com',
  ].join('\n'))
  assert.deepEqual(Object.fromEntries(aliases), {
    'github-work': 'github.com',
    'gh-alt': 'github.com',
    gh443: 'ssh.github.com',
  })
  assert.equal(remoteToRepo('git@github-work:acme/x.git', aliases)?.slug, 'acme/x')
  assert.equal(remoteToRepo('GitHub-Work:acme/x', aliases)?.slug, 'acme/x', 'scp-like without a user')
  assert.equal(remoteToRepo('ssh://git@gh443:443/acme/y.git', aliases)?.slug, 'acme/y')
  assert.equal(remoteToRepo('git@github-work:acme/x.git'), null, 'no alias map, no guess')
  assert.equal(remoteToRepo('git@gitlab-work:acme/x.git', aliases), null)
  assert.equal(remoteToRepo('https://github-work/acme/x.git', aliases), null, 'aliases are SSH-only')
  assert.equal(remoteToRepo('git@ssh.github.com:acme/z.git')?.slug, 'acme/z')
  assert.equal(remoteToRepo('https://github.com/acme/w.git')?.slug, 'acme/w')
})

check('the picked clone maps upstream, then origin, then the first GitHub remote', () => {
  const remotes = [
    { name: 'mine', url: 'git@github.com:me/x.git' },
    { name: 'origin', url: 'git@github.com:fork/x.git' },
    { name: 'upstream', url: 'https://github.com/acme/x.git' },
  ]
  assert.equal(chooseCloneRepo(remotes), 'acme/x')
  assert.equal(chooseCloneRepo(remotes.slice(0, 2)), 'fork/x')
  assert.equal(chooseCloneRepo([{ name: 'gl', url: 'git@gitlab.com:a/b.git' }, remotes[0]]), 'me/x')
  assert.equal(chooseCloneRepo([{ name: 'upstream', url: 'git@gitlab.com:a/b.git' }, remotes[1]]), 'fork/x')
  assert.equal(chooseCloneRepo([{ name: 'origin', url: 'git@work:a/b.git' }], new Map([['work', 'github.com']])), 'a/b')
  assert.equal(chooseCloneRepo([]), null)
})

check('manual clone paths match repositories case-insensitively', () => {
  const paths = { 'Acme/App': '/a', 'acme/app': '/b', 'other/x': '/c' }
  assert.equal(lookupRepoPath(paths, 'acme/app'), '/b', 'exact case wins')
  assert.equal(lookupRepoPath(paths, 'ACME/APP'), '/a')
  assert.equal(lookupRepoPath(paths, 'Other/X'), '/c')
  assert.equal(lookupRepoPath(paths, 'none/x'), '')
})

await checkAsync('a manual clone path matches the repository case-insensitively at launch', async () => {
  await withPlatformHost('darwin', (spec, handle) => {
    if (spec.argv[3] === 'triage-desk') return handle(0, probeOutput(spec.argv.slice(4), (name) => '/usr/bin/' + name))
    return handle()
  }, async ({ request }) => {
    const result = await request('/triage-desk/launch', 'POST', { url: 'https://github.com/ACME/app/pull/1', agent: 'codex' })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.cwd, '/offline/acme-app')
    assert.equal(result.body.cwdMode, 'clone')
  }, { repoPaths: { 'acme/App': '/offline/acme-app' } })
})

await checkAsync('clone scans follow symlinked directories without looping', async () => {
  const root = path.join(fixture, 'links')
  const outside = path.join(fixture, 'outside-tree', 'linked-repo')
  await fs.mkdir(path.join(root, 'nested'), { recursive: true })
  await fs.mkdir(path.join(outside, '.git'), { recursive: true })
  await fs.writeFile(path.join(outside, '.git', 'config'), '[remote "origin"]\n\turl = git@github-work:acme/linked.git\n')
  await fs.symlink(path.dirname(outside), path.join(root, 'nested', 'to-outside'))
  await fs.symlink(root, path.join(root, 'nested', 'loop'))
  await fs.symlink(path.join(root, 'nested'), path.join(root, 'nested-again'))
  const result = await scanCloneDirs([root], { sshHosts: new Map([['github-work', 'github.com']]) })
  assert.deepEqual(result.clones, [{ repo: 'acme/linked', path: path.join(root, 'nested', 'to-outside', 'linked-repo') }])
  assert.ok(result.visited <= 5, 'every real directory is visited once: ' + result.visited)
  const home = path.join(fixture, 'link-home')
  await fs.mkdir(home, { recursive: true })
  await fs.symlink(path.dirname(outside), path.join(home, 'Projects'))
  assert.deepEqual(await discoverCloneRoots(home), [path.join(home, 'Projects')])
})

await checkAsync('auto clone roots keep existing defaults beside discovered roots', async () => {
  // Real filesystem under a fake HOME: ~/Documents/GitHub is two levels down,
  // where home discovery cannot see it, and ~/.ssh/config maps an alias.
  const home = path.join(fixture, 'auto-home')
  const nestedDefault = path.join(home, 'Documents', 'GitHub', 'org', 'deep')
  const discovered = path.join(home, 'Playground', 'tool')
  await fs.mkdir(path.join(nestedDefault, '.git'), { recursive: true })
  await fs.mkdir(path.join(discovered, '.git'), { recursive: true })
  await fs.mkdir(path.join(home, '.ssh'), { recursive: true })
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host github-work\n  HostName github.com\n')
  await fs.writeFile(path.join(nestedDefault, '.git', 'config'), '[remote "origin"]\n\turl = git@github-work:acme/deep.git\n')
  await fs.writeFile(path.join(discovered, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/tool.git\n')
  const routes = new Map()
  const oldHome = process.env.HOME
  process.env.HOME = home
  try {
    apply({
      logger: () => ({ info() {}, warn() {}, error() {} }),
      effect: (fn) => fn(),
      webServer: { register: (route) => { routes.set(route.path, route); return () => {} } },
      connection: { requestRejection: () => undefined },
      subprocess: { spawn: () => { throw new Error('no subprocess expected') }, resolveExecutable: async (name) => name },
      tools: { register() {} },
      systemPrompt: { section() {} },
      get: () => undefined,
    }, { cwd: home })
    const req = Readable.from([])
    Object.assign(req, { method: 'GET', url: '/triage-desk/clones', headers: {} })
    const res = { statusCode: 0, body: '', setHeader() {}, end(text) { this.body = text || '' } }
    await routes.get('/triage-desk/clones').handler(req, res)
    const payload = JSON.parse(res.body)
    assert.equal(res.statusCode, 200, res.body)
    const dirs = payload.dirs.map((dir) => dir.path)
    assert.ok(dirs.includes(path.join(home, 'Documents', 'GitHub')), JSON.stringify(dirs))
    assert.ok(dirs.includes(path.join(home, 'Playground')), JSON.stringify(dirs))
    assert.equal(dirs.some((dir) => dir.endsWith('/Projects')), false, 'missing defaults are not scanned')
    const repos = payload.clones.map((clone) => clone.repo).sort()
    assert.deepEqual(repos, ['acme/deep', 'acme/tool'])
  } finally {
    process.env.HOME = oldHome
  }
})

/* ------------------------------------------------------------------------ */
/* Windows Terminal title                                                    */
/* ------------------------------------------------------------------------ */

check('Windows Terminal arguments escape the ; command separator', () => {
  const scriptPath = 'C:\\Temp\\a;b\\launch.ps1'
  for (const tab of [true, false]) {
    const plan = openTerminalPlan('win32', { scriptPath, title: 'Fix; then \\; review', wt: 'wt', tab })
    const title = plan.argv[plan.argv.indexOf('--title') + 1]
    assert.equal(title, 'Fix\\; then \\\\; review')
    assert.equal(plan.argv[plan.argv.length - 1], 'C:\\Temp\\a\\;b\\launch.ps1')
    // Mirror wt: split on /^;|[^\\];/ per argument, then AddArg turns \; into ;.
    for (const arg of plan.argv.slice(1)) assert.equal(/^;|[^\\];/.test(arg), false, arg)
    assert.equal(title.split('\\;').join(';'), 'Fix; then \\; review')
  }
  const cmd = openTerminalPlan('win32', { scriptPath: 'C:\\x.ps1', title: 'a;b' })
  assert.equal(cmd.argv.includes('a\\;b'), false, 'cmd.exe start has no wt parsing')
})

await fs.rm(fixture, { recursive: true, force: true })

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} launcher checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('launcher smoke OK')
}
