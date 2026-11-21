/**
 * Render smoke test for the client half: loads the bundle with real React,
 * renders the registered Page against a deterministic snapshot, and fails if
 * rendering throws or the expected sections/rows are missing.
 *
 * Run with `npm run smoke:render`. This catches client components that read
 * props/state they no longer receive, which the fake-loader smoke cannot see.
 * Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { snapshot } from './fixtures/snapshot.mjs'
import { defaultScenarios, SCENARIO_SECTION_LABELS } from '../launcher.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = []
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => registry.push(registration),
  },
}

const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
const requireFromClient = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
new Function('window', 'require', source)(globalThis.window, requireFromClient)

const registration = registry[0]
assert.ok(registration && typeof registration.factory === 'function', 'client bundle must register a factory')
const plugin = registration.factory(requireFromClient)
assert.equal(typeof plugin.apply, 'function')

const registrations = []
const fakeCtx = {
  effect: (callback) => {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject: (_key, callback) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  get: (name) => (name === 'uiWorkspace' ? { startSession: () => {} } : undefined),
}
plugin.apply(fakeCtx)

const pageRegistration = registrations.find((entry) => entry.options.name === 'main' && entry.options.key === 'triage-desk')
assert.ok(pageRegistration, 'main page slot must be registered')
assert.equal(typeof pageRegistration.component, 'function')

const state = {
  status: 'ready',
  refreshing: false,
  data: snapshot,
  error: null,
  filter: 'all',
  sourceFilter: 'all',
  collapsed: {},
  copied: null,
  copiedList: 0,
  loadedAt: Date.now(),
  view: 'list',
  openMenu: null,
  config: {
    orgs: [],
    sources: snapshot.sources,
    cloneDirsDefault: ['~/Projects'],
    agents: [
      { id: 'claude', label: 'Claude Code', command: 'claude {prompt}', draftFlag: '--prefill' },
      { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
    ],
    defaultAgent: 'claude',
    detectedAgents: { claude: { available: true }, codex: { available: true } },
    scenarios: [
      {
        id: 'link',
        label: '',
        scope: 'item',
        sections: ['review', 'rereview', 'merge', 'respond', 'ci', 'issues'],
        prompt: '{url}',
        agent: 'default',
        enabled: true,
      },
      {
        id: 'review-pr',
        label: '',
        scope: 'item',
        sections: ['review'],
        prompt: 'Review the pull request {url}.',
        agent: 'default',
        enabled: true,
      },
      {
        id: 'review-all',
        label: '',
        scope: 'section',
        sections: ['review', 'rereview'],
        prompt: 'Review every pull request listed below.\n\n{links}',
        agent: 'default',
        enabled: true,
      },
    ],
    defaultScenario: 'link',
    supportsPrompt: true,
    supportsAgentDiscovery: true,
    scenarioDefaults: [
      {
        id: 'link',
        label: '',
        scope: 'item',
        sections: ['review', 'rereview', 'merge', 'respond', 'ci', 'issues'],
        prompt: '{url}',
        agent: 'default',
        enabled: true,
      },
    ],
    limits: { scenarios: 30, scenarioTemplate: 4000, prompt: 16000 },
    editable: true,
  },
  configStatus: 'ready',
  configError: null,
  saveError: null,
  auth: { available: true, authenticated: true, login: 'tester', scopes: ['repo'], install: null },
  authStatus: 'ready',
  authError: null,
  loginStatus: 'idle',
  loginError: null,
  pollSeconds: 1200,
  toast: null,
}
const store = {
  get: () => state,
  set: () => {},
  subscribe: () => () => {},
  load: () => Promise.resolve(),
  loadConfig: () => Promise.resolve(),
  loadAuth: () => Promise.resolve(),
  loginGithub: () => Promise.resolve(),
  showToast: () => {},
  dispose: () => {},
}

const t = (key, params) => params?.line === undefined ? key : key + ':' + params.line
// The hook runner also shows interpolated values (relative ages, counts).
const harnessT = (key, params) => (params ? key + ':' + Object.values(params).join(',') : key)
const html = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(html.includes('adx-root'), 'page root should render')
assert.ok(html.includes('Review requested PR'), 'review row should render')
assert.ok(html.includes('Re-review needed PR'), 'rereview row should render')
assert.ok(html.includes('Merge-ready PR'), 'merge row should render')
assert.ok(html.includes('New unassigned issue'), 'issue row should render')
assert.ok(html.includes('adx-section'), 'sections should render')
assert.ok(html.includes('adx-section-launch'), 'section scenario trigger should render')
assert.ok(html.includes('launch.sectionTitle'), 'section trigger should carry its accessible label')
{
  // Header controls follow a row's order: terminal, snooze, then the chevron in the copy column.
  const head = html.slice(html.indexOf('<div class="adx-section-head"'), html.indexOf('</div>', html.indexOf('<div class="adx-section-head"')) + 6)
  const order = ['launch.sectionTitle', 'snooze.section', 'page.collapse'].map((label) => head.indexOf('aria-label="' + label))
  assert.ok(order.every((index) => index !== -1), 'the header renders terminal, snooze and chevron: ' + order)
  assert.ok(order[0] < order[1] && order[1] < order[2], 'header order is terminal, snooze, chevron')
  const row = html.slice(html.indexOf('<li class="adx-row"'), html.indexOf('</li>', html.indexOf('<li class="adx-row"')))
  const rowOrder = ['launch.title', 'snooze.button', 'page.copy'].map((label) => row.indexOf('aria-label="' + label))
  assert.ok(rowOrder[0] < rowOrder[1] && rowOrder[1] < rowOrder[2], 'row order is terminal, snooze, copy: ' + rowOrder)
}

state.openMenu = 'section:review'
const withMenu = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(withMenu.includes('adx-launch-menu'), 'section scenario menu should render when open')
assert.ok(withMenu.includes('<div class="adx-section-head" data-menu-open="true">'), 'the section header owning the open menu is lifted')
assert.ok(withMenu.includes('launch.reviewOne'), 'the review action counts only its own group in All')
assert.ok(withMenu.includes('adx-launch-agent-select'), 'section menu should let you pick the agent')
assert.ok(withMenu.includes('launch.dshTarget'), 'section menu should offer the DSH target')

state.openMenu = 'review:pull:1'
const rowMenu = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(rowMenu.includes('launch.scenarios'), 'row menu should group scenarios')
assert.ok(rowMenu.includes('review-pr'), 'row menu should list the applicable item scenario')
assert.ok(rowMenu.includes('adx-launch-agent-select'), 'row menu should let you pick the agent')
assert.ok(rowMenu.includes('launch.dshTarget'), 'row menu should offer the DSH target')
state.config.detectedAgents = { claude: { available: true }, codex: { available: false, path: null, reason: 'alias' } }
const aliasMenu = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(aliasMenu.includes('launch.agentShellAlias'), 'an alias-only agent explains why it cannot launch')
assert.ok(!aliasMenu.includes('launch.notInstalled'), 'an alias is not reported as missing')
state.config.detectedAgents = { claude: { available: true }, codex: { available: true } }

const count = (text, needle) => text.split(needle).length - 1
state.openMenu = 'respond:pull:4'
state.copied = 'respond:pull:4'
const duplicateRow = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.equal(count(duplicateRow, 'href="https://github.com/tester/example/pull/4"'), 2, 'the fixture lists one PR in two sections')
assert.equal(count(duplicateRow, 'class="adx-launch-menu"'), 1, 'a PR listed in two sections opens one menu, not two')
assert.equal(count(duplicateRow, 'data-menu-open="true"'), 1, 'only the row owning the open menu is lifted above its siblings')
assert.ok(/<li class="adx-row"[^>]*data-menu-open="true"[^>]*>(?:(?!<li ).)*class="adx-launch-menu"/s.test(duplicateRow),
  'the lifted row is the one that renders the menu')
assert.equal(count(duplicateRow, 'aria-label="page.copied"'), 1, 'the copied tick belongs to one row only')
state.copied = null

state.openMenu = null
state.view = 'settings'
const settingsHtml = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(!settingsHtml.includes('settings.sshServers') && !settingsHtml.includes('settings.byTask'), 'older hosts only offer supported launcher settings')
assert.ok(settingsHtml.includes('adx-scenarios'), 'settings should render the scenario editor')
assert.ok(settingsHtml.includes('settings.scenarios'), 'settings should group scenarios')
assert.ok(settingsHtml.includes('settings.agentAdd'), 'settings should render the agent editor')
assert.ok(settingsHtml.includes('settings.agentFind'), 'settings should offer the agent scan when the host supports it')
assert.ok(settingsHtml.includes('adx-scenario'), 'each scenario should render as a compact card')
assert.ok(settingsHtml.includes('review-pr'), 'the scenario list should render the configured scenarios')
assert.ok(settingsHtml.includes('claude {prompt}'), 'the agent editor should render the configured commands')

assert.ok(!settingsHtml.includes('settings.agentsUnusable'), 'no unusable-agents warning without host-reported agents')
state.config.invalidAgents = []
assert.ok(!renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store })).includes('settings.agentsUnusable'),
  'an empty invalidAgents list renders no warning')
state.config.invalidAgents = [{ id: 'legacy', label: 'Legacy agent', command: 'legacy "{prompt}"', reason: 'placeholder' }]
const settingsWithUnusable = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(settingsWithUnusable.includes('settings.agentsUnusable'), 'saved agents the host cannot use are reported')
assert.ok(settingsWithUnusable.includes('settings.agentsUnusableHint'))
assert.ok(settingsWithUnusable.includes('value="Legacy agent"') && settingsWithUnusable.includes('value="legacy &quot;{prompt}&quot;"'),
  'each unusable agent is an editable row with its label and command')
assert.ok(settingsWithUnusable.includes('data-invalid="true"') && settingsWithUnusable.includes('settings.agentUnusableRow'),
  'the unusable row is flagged inline')
delete state.config.invalidAgents

state.config.supportsAgentDiscovery = false
const settingsWithoutScan = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(!settingsWithoutScan.includes('settings.agentFind'), 'a stale host must hide the Find agents button')
state.config.supportsAgentDiscovery = true

state.view = 'list'
state.data = {
  ...snapshot,
  status: 'stale',
  warnings: [{ code: 'partial', message: 'old coverage warning' }, { code: 'network', message: 'refresh failed, showing the previous snapshot: offline' }],
  meta: { ...snapshot.meta, lastError: { code: 'network', message: 'gh: connection refused' } },
}
const staleHtml = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(staleHtml.includes('gh: connection refused'), 'the stale banner shows the current failure from meta.lastError')
assert.ok(!staleHtml.includes('old coverage warning'), 'the stale banner does not show an older warning')
state.data = { ...state.data, meta: { ...snapshot.meta } }
const staleFallback = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(staleFallback.includes('refresh failed, showing the previous snapshot: offline'), 'without lastError the latest warning is shown')
state.data = snapshot

// Coverage limits get their own quiet notice; only failures make the
// "couldn't be loaded" banner, one line per problem.
const limit = (code, source, params) => ({ code, kind: 'limit', source, params, message: code + ' message' })
state.data = {
  ...snapshot,
  status: 'ok',
  sources: [...snapshot.sources, { kind: 'org', login: 'llvm', label: 'llvm', large: true }],
  warnings: [
    limit('source-degraded', 'llvm', { max: 50 }),
    limit('branch-scan-narrowed', 'llvm', { login: 'tester', scanned: 1, total: 1 }),
    limit('truncated-history', null, {}),
  ],
}
const limitsHtml = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(limitsHtml.includes('adx-limits-details') && limitsHtml.includes('limits.title') && limitsHtml.includes('limits.leadLarge'), 'limits get their own notice')
assert.ok(limitsHtml.includes('limit.sourceDegraded') && limitsHtml.includes('limit.branchNarrowedOne') && limitsHtml.includes('limit.history'))
assert.ok(limitsHtml.includes('<details') && !limitsHtml.includes('<details open'), 'the limits list starts collapsed')
assert.ok(limitsHtml.includes('REFERENCE.md#large-sources'), 'the notice links the explanation')
assert.ok(!limitsHtml.includes('page.partial') && !limitsHtml.includes('source-degraded message'), 'limits are not shown as failures or raw messages')
state.data = { ...snapshot, status: 'partial', warnings: [limit('branch-scan-narrowed', 'llvm', { login: 'tester', scanned: 0, total: 2 })] }
const failedNarrow = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(failedNarrow.includes('limit.branchNarrowedSome') && !failedNarrow.includes('limit.branchNarrowedNone'),
  'repositories that failed to load are not "no repositories"')
state.data = {
  ...snapshot,
  status: 'ok',
  sources: [{ kind: 'org', login: 'llvm', label: 'llvm', large: true }, { kind: 'org', login: 'acme', label: 'acme', large: false }],
  warnings: [limit('prs-truncated', 'acme', { list: 'authored', read: 100, total: 140 })],
}
const unlistedLarge = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(!unlistedLarge.includes('limits.leadLarge') && unlistedLarge.includes('limits.lead'),
  'a large source with no limit in this refresh is not named in the lead')
state.data = { ...snapshot, status: 'partial', warnings: [limit('repos-truncated', 'acme', { scanned: 300, total: 900 })] }
assert.ok(!renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store })).includes('page.partial'),
  'no failure banner without a failure to list')
state.data = {
  ...snapshot,
  status: 'ok',
  warnings: [limit('prs-truncated', 'a-very-long-organization-login', { list: 'authored', read: 100, total: 140 }), limit('repos-truncated', 'acme', { scanned: 300, total: 900 })],
}
const tagged = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(tagged.includes('data-tone="info"') && tagged.includes('adx-limits'), 'the limits notice keeps its tone and class')
assert.ok(tagged.includes('title="a-very-long-organization-login"') && tagged.includes('adx-pill-text'), 'a long source tag ellipsizes and has a tooltip')
state.data = { ...snapshot, status: 'ok', warnings: [limit('orgs-truncated', null, { max: 10 })] }
const orgsHtml = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(orgsHtml.includes('limits.titleGeneral') && orgsHtml.includes('limit.orgsTruncated'), 'the organization cap is a limit')
assert.ok(!orgsHtml.includes('limits.lead'), 'the organization cap is not called a recency cut')
state.data = { ...snapshot, status: 'ok', warnings: [limit('prs-truncated', 'acme', { list: 'authored', read: 100, total: 140 })] }
assert.ok(renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store })).includes('limits.lead'),
  'a list cut to its most recent part says so')
state.data = {
  ...snapshot,
  status: 'ok',
  warnings: [limit('source-degraded', 'llvm', { max: 50 }), limit('truncated-history', null, {}), limit('prs-truncated', 'acme', { list: 'authored', read: 100, total: 140 })],
}
const grouped = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(grouped.indexOf('limit.prsTruncated') < grouped.indexOf('limit.history'), 'limits are grouped by source, general ones last')
state.data = { ...snapshot, status: 'ok', warnings: [limit('truncated-history', null, {})] }
assert.ok(!renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store })).includes('adx-limits'),
  'old history on long pull requests alone is no notice')
state.data = {
  ...snapshot,
  status: 'partial',
  warnings: [
    { code: 'source-unavailable', message: 'org:acme: pull request search failed: HTTP 500' },
    { code: 'search-unavailable', message: 'acme: issue search failed: HTTP 500' },
    limit('prs-truncated', 'llvm', { list: 'reviewRequested', read: 50, total: 900 }),
  ],
}
const partialHtml = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(partialHtml.includes('page.partial'), 'failures keep the warning banner')
assert.ok(partialHtml.includes('<li>org:acme: pull request search failed: HTTP 500</li><li>acme: issue search failed: HTTP 500</li>'), 'one line per problem')
assert.ok(!partialHtml.includes('; acme'), 'problems are not glued with semicolons')
assert.ok(partialHtml.includes('limit.prsTruncated') && !partialHtml.includes('prs-truncated message'), 'limits stay out of the failure banner')
state.data = snapshot

// Windows draws select lists from the option styles: they must use the theme.
// The stylesheet is injected into document.head, so check the client source.
assert.ok(/\.adx-select option, \.adx-select optgroup \{\s*background-color: var\(--dsw-alias-bg-elevated/.test(source),
  'select options take the theme surface, not the white default')
assert.ok(source.includes('body[data-ds-dark-theme] .adx-root { color-scheme: dark; }'), 'native controls follow the DSH dark theme')

// An older host (no defaultTarget) would reject "dsh" on save: no DSH option.
{
  const view = state.view
  state.view = 'settings'
  const olderHost = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(!olderHost.includes('<option value="dsh"'), 'Settings offers DSH only to a host that saves it')
  state.view = view
}

// A saved default agent that is not installed: the launch menu preselects the
// host's effective default, and Settings keeps the saved one with a hint.
{
  const saved = { ...state.config }
  state.config = {
    ...state.config,
    defaultAgent: 'claude',
    defaultTarget: 'dsh',
    effectiveDefaultAgent: 'codex',
    detectedAgents: { claude: { available: false, reason: 'missing' }, codex: { available: true } },
  }
  state.openMenu = 'review:pull:1'
  const menu = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(/<option value="dsh" selected="">/.test(menu), 'a default that cannot start opens a DSH chat')
  state.config = { ...state.config, supportsPrompt: false }
  const noDsh = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(/<option value="codex" selected="">/.test(noDsh), 'without the DSH target, the installed agent')
  state.openMenu = null
  state.view = 'settings'
  const noDshSettings = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(!noDshSettings.includes('<option value="dsh">'), 'Settings does not offer a DSH target the panel cannot open')
  state.config = { ...state.config, defaultAgent: 'dsh', defaultTarget: 'dsh' }
  const savedDsh = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(/<option value="dsh" selected="">/.test(savedDsh), 'a saved DSH default is still shown')
  assert.ok(savedDsh.includes('settings.defaultDshUnavailable'), 'and Settings says what launches use instead')
  state.config = { ...state.config, defaultAgent: 'claude', supportsPrompt: true }
  state.view = 'list'
  state.openMenu = 'review:pull:1'
  state.openMenu = null
  state.view = 'settings'
  const settings = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
  assert.ok(settings.includes('settings.defaultAgentFallback'), 'Settings explains what launches open instead')
  assert.ok(/<option value="claude" data-missing="true" selected="">/.test(settings), 'Settings keeps the saved choice, marked missing')
  assert.ok(settings.includes('<option value="dsh">launch.dshTarget</option>'), 'DSH can be chosen as the default')
  state.config = { ...state.config, defaultAgent: 'dsh', defaultTarget: 'dsh' }
  state.view = 'list'
  state.openMenu = 'review:pull:1'
  assert.ok(/<option value="dsh" selected="">/.test(renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))),
    'a DSH default preselects DSH')
  state.openMenu = null
  state.config = saved
}

state.openMenu = 'review:pull:1'
state.config.supportsPrompt = false
const menuWithoutDsh = renderToStaticMarkup(React.createElement(pageRegistration.component, { t, store }))
assert.ok(!menuWithoutDsh.includes('launch.dshTarget'), 'a stale host must hide the DSH target')
state.config.supportsPrompt = true
state.openMenu = null

/** React.memo's default comparison: same keys, each value Object.is-equal. */
function shallowEqualProps(previous, next) {
  const keys = Object.keys(previous)
  if (keys.length !== Object.keys(next).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(next, key) && Object.is(previous[key], next[key]))
}

// A stateful hook runner exercises the registered Page/Settings event handlers
// and effects against the real store. It honours React.memo comparators (a
// memoized subtree is reused unless its own state changed), runs layout effects
// before passive ones, and attaches object refs to minimal fake elements
// (contains/focus/querySelector/getBoundingClientRect) so document-level menu
// handlers can be driven deterministically. React DOM scheduling is not
// simulated; the real-React SSR checks above cover rendering compatibility.
function settingsHarness({
  agents = state.config.agents, invalidAgents, scenarios, snapshotPayload = null, clock = null, layout = {}, configExtra = {},
  storage, withPanel = false, clipboard, workspace = fakeCtx.get('uiWorkspace'), prompt = 'rendered', trimmed = null,
  terminal = { id: 'iterm', label: 'iTerm2', fallback: false },
} = {}) {
  const instances = new Map()
  let current
  let hookIndex
  let dirty = true
  let tree
  let root
  let effects = []
  let layoutEffects = []
  const elements = new Map()
  const nodeKeys = new WeakMap()
  const documentListeners = new Map()
  let focused = null
  const hook = (initialize) => {
    const index = hookIndex++
    if (!current.hooks[index]) current.hooks[index] = initialize()
    return current.hooks[index]
  }
  const effectHook = (queue) => (callback, dependencies) => {
    const entry = hook(() => ({}))
    if (!entry.dependencies || dependencies.some((value, i) => !Object.is(value, entry.dependencies[i]))) {
      entry.dependencies = dependencies
      queue().push(() => { entry.cleanup?.(); entry.cleanup = callback() })
    }
  }
  let hookIds = 0
  const hooks = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    // Without a comparator React compares props shallowly with Object.is.
    memo: (component, compare) => ({ memo: true, component, compare: compare || shallowEqualProps }),
    useState(initial) {
      const owner = current
      const entry = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      return [entry.value, (update) => {
        const value = typeof update === 'function' ? update(entry.value) : update
        if (!Object.is(value, entry.value)) { entry.value = value; owner.pending = true; dirty = true }
      }]
    },
    useRef(initial) { return hook(() => ({ current: initial })) },
    useId() { return hook(() => ({ id: ':h' + String(++hookIds) + ':' })).id },
    useMemo(factory, dependencies) {
      const entry = hook(() => ({}))
      if (!entry.dependencies || dependencies.some((value, i) => !Object.is(value, entry.dependencies[i]))) {
        entry.dependencies = dependencies
        entry.value = factory()
      }
      return entry.value
    },
    useEffect: effectHook(() => effects),
    useLayoutEffect: effectHook(() => layoutEffects),
  }
  const elementFor = (key) => {
    if (!elements.has(key)) {
      elements.set(key, {
        key,
        node: null,
        contains: (target) => Boolean(target) && (target.key === key || String(target.key).startsWith(key + '/')),
        focus() { focused = key },
        select() { host.selectedText = this.node.props.value },
        getBoundingClientRect() {
          const className = String(this.node?.props?.className || '')
          if (className.includes('adx-launch-menu')) return { top: 0, bottom: layout.menuHeight ?? 120, height: layout.menuHeight ?? 120 }
          return { top: (layout.triggerBottom ?? 100) - 20, bottom: layout.triggerBottom ?? 100, height: 20 }
        },
        querySelector(selector) {
          assert.ok(selector === '[role="menuitem"]' || selector === 'select')
          const match = flatten(this.node?.props?.children).find((child) => selector === 'select' ? child?.type === 'select' : child?.props?.role === 'menuitem')
          return match ? elementFor(nodeKeys.get(match)) : null
        },
      })
    }
    return elements.get(key)
  }
  function render() {
    for (let pass = 0; pass < 50; pass++) {
      dirty = false
      effects = []
      layoutEffects = []
      const visited = new Set()
      const instanceFor = (key, type) => {
        let instance = instances.get(key)
        if (instance && instance.type !== type) {
          for (const entry of instance.hooks) entry.cleanup?.()
          instances.delete(key)
          instance = null
        }
        if (!instance) {
          instance = { type, hooks: [] }
          instances.set(key, instance)
        }
        visited.add(key)
        return instance
      }
      const visit = (node, key) => {
        if (Array.isArray(node)) return node.map((child, i) => visit(child, key + '/' + (child?.props?.key ?? i)))
        if (node === null || typeof node !== 'object') return node
        if (node.type?.memo) {
          const instance = instanceFor(key, node.type)
          // Own (or descendant) state updates re-render the subtree, as in React;
          // otherwise the comparator decides, so a missing prop compare is caught.
          const pendingInside = [...instances].some(([inner, entry]) => inner.startsWith(key + '/') && entry.pending)
          if (instance.memoProps && !pendingInside && node.type.compare(instance.memoProps, node.props)) {
            // Reuse the previous subtree; keep its descendant instances alive.
            for (const descendant of instances.keys()) if (descendant.startsWith(key + '/')) visited.add(descendant)
            return instance.memoTree
          }
          instance.memoProps = node.props
          instance.memoTree = visit({ type: node.type.component, props: node.props }, key + '/memo')
          return instance.memoTree
        }
        if (typeof node.type === 'function') {
          current = instanceFor(key, node.type)
          current.pending = false
          hookIndex = 0
          return visit(node.type(node.props), key + '/render')
        }
        const element = { ...node, props: { ...node.props, children: visit(node.props.children, key + '/children') } }
        nodeKeys.set(element, key)
        if (element.props.ref && typeof element.props.ref === 'object') {
          const fake = elementFor(key)
          fake.node = element
          element.props.ref.current = fake
        }
        return element
      }
      tree = visit(root, 'root')
      for (const [key, instance] of instances) {
        if (visited.has(key)) continue
        for (const entry of instance.hooks) entry.cleanup?.()
        instances.delete(key)
      }
      for (const effect of layoutEffects) effect()
      for (const effect of effects) effect()
      if (!dirty) return
    }
    throw new Error('settings hook runner did not settle')
  }
  const flatten = (node) => {
    if (Array.isArray(node)) return node.flatMap(flatten)
    if (node === null || node === undefined || node === false) return []
    return typeof node === 'object' ? [node, ...flatten(node.props.children)] : [node]
  }
  const slots = []
  const disposers = []
  const pending = []
  const pendingDiscoveries = []
  const pendingPickers = []
  const launches = []
  const timers = new Map()
  let timerId = 0
  const config = {
    ...state.config,
    agents,
    scenarios: scenarios ?? (snapshotPayload === null
      ? state.config.scenarios.filter((scenario) => scenario.id === 'link')
      : state.config.scenarios),
    ...(invalidAgents === undefined ? {} : { invalidAgents }),
    refreshSeconds: 1200,
    ...configExtra,
  }
  // `host.snapshot` replaces the served snapshot for later loads. Snapshot
  // reads are counted; `holdSnapshots` parks them in `pendingSnapshots` until
  // released, and `failSnapshots` answers that many of them with a 404.
  const host = {
    saveError: null, unavailable: false, configReads: 0, snapshot: null,
    snapshotReads: 0, holdSnapshots: false, failSnapshots: 0, pendingSnapshots: [],
  }
  const response = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload })
  const document = {
    visibilityState: 'visible',
    // Styles are outside this harness; report them as installed.
    querySelector: () => ({}),
    // Listeners keep their capture flag: dispatch runs capture listeners
    // first and stops at stopPropagation(), as a browser does for document.
    addEventListener(type, callback, options) {
      if (!documentListeners.has(type)) documentListeners.set(type, new Map())
      documentListeners.get(type).set(callback, options === true || Boolean(options && options.capture))
    },
    removeEventListener(type, callback) { documentListeners.get(type)?.delete(callback) },
  }
  const sandbox = {
    console,
    document,
    navigator: { clipboard },
    innerHeight: layout.innerHeight ?? 800,
    ...(storage === undefined ? {} : { localStorage: storage }),
    ...(clock === null ? {} : { Date: class extends Date { static now() { return clock.now } } }),
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    fetch(url, options) {
      if (url === '/triage-desk/pick-directory' || url === '/triage-desk/pick-clone') {
        return new Promise((resolve, reject) => pendingPickers.push({ resolve, reject, url }))
      }
      if (url === '/triage-desk/ssh/check') {
        (host.probed ??= []).push(JSON.parse(options.body).alias)
        return Promise.resolve(host.sshError ? response(502, { error: { message: host.sshError } }) :
          response(200, { ok: true, agents: [{ id: 'claude', label: 'Claude Code' }] }))
      }
      if (url === '/triage-desk/clones?refresh=1&sshAlias=old') {
        return Promise.resolve(response(200, { ok: true, clones: [{ repo: 'acme/widgets', path: '/original/fork' }] }))
      }
      if (url === '/triage-desk/agents/find') {
        return new Promise((resolve, reject) => pendingDiscoveries.push({ resolve, reject, body: JSON.parse(options.body) }))
      }
      if (url === '/triage-desk/launch' || url === '/triage-desk/prompt') {
        const body = JSON.parse(options.body)
        launches.push({ url, body })
        return Promise.resolve(response(200, url === '/triage-desk/launch'
          ? {
              ok: true,
              mode: 'draft',
              cwd: '/work',
              count: trimmed?.shown ?? (body.urls ? body.urls.length : 1),
              trimmed,
              sshAlias: body.sshAlias,
              agent: { id: 'claude', label: 'Claude Code' },
              terminal,
              delivery: { mode: 'draft', pasteBlocked: null, platform: 'darwin' },
            }
          : { ok: true, prompt, trimmed, scenario: { id: body.scenario || 'review-pr' } }))
      }
      if (url === '/triage-desk/config' && options.method === 'POST') {
        return new Promise((resolve, reject) => pending.push({ resolve, reject, body: JSON.parse(options.body) }))
      }
      if (url === '/triage-desk/config') host.configReads += 1
      if (url === '/triage-desk/config' && host.unavailable) return Promise.reject(new Error('restarting'))
      if (url === '/triage-desk/config') return Promise.resolve(response(200, { config, saveError: host.saveError }))
      if (url === '/triage-desk/auth') return Promise.resolve(response(200, { auth: state.auth }))
      if (url.split('?')[0] === '/triage-desk/snapshot') {
        host.snapshotReads += 1
        // Like the host, the default snapshot reports the saved refresh setting
        // as of when the read started.
        const served = host.snapshot ?? snapshotPayload ?? { sections: [], settings: { refreshSeconds: config.refreshSeconds } }
        const failed = host.failSnapshots > 0
        if (failed) host.failSnapshots -= 1
        const answer = failed ? response(404, null) : response(200, served)
        if (host.holdSnapshots) return new Promise((resolve) => host.pendingSnapshots.push(() => resolve(answer)))
        return Promise.resolve(answer)
      }
      throw new Error('unexpected request: ' + url)
    },
  }
  sandbox.window = {
    ...sandbox,
    __ModuleLoader__: {
      load(registration) {
        registration.factory((name) => {
          assert.equal(name, 'react')
          return hooks
        }).apply({
          ...fakeCtx,
          get: (name) => name === 'uiWorkspace' ? workspace : undefined,
          effect(callback) { disposers.push(callback()) },
          slots: {
            inject: (_key, callback) => callback(),
            register(options, component) { slots.push({ options, component }); return () => {} },
          },
        })
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const page = slots.find((slot) => slot.options.name === 'main')
  const { store } = page.options.inject()
  root = hooks.createElement(page.component, { store, t: harnessT })
  if (withPanel) {
    const panel = slots.find((slot) => slot.options.name === 'sidebar.panellist')
    root = hooks.createElement('div', null, root, hooks.createElement(panel.component, { store }))
  }
  render()
  const target = (node) => (node === null ? { key: 'outside' } : elementFor(nodeKeys.get(node)))
  const event = (node, extra = {}) => ({ preventDefault() {}, stopPropagation() {}, target: target(node), ...extra })
  return {
    store, pending, pendingDiscoveries, pendingPickers, launches, timers, host,
    nodes: () => flatten(tree),
    text: () => flatten(tree).filter((node) => typeof node === 'string').join(' '),
    focused: () => focused,
    keyOf: (node) => nodeKeys.get(node),
    async flush() { await new Promise((resolve) => setImmediate(resolve)); render() },
    change(node, value) { node.props.onChange({ target: { value } }); render() },
    click(node, extra) { assert.ok(node, 'expected an interactive control'); assert.ok(!node.props.disabled); node.props.onClick(event(node, extra)); render() },
    // Document-level events reach the listeners the menu effects registered.
    dispatch(type, node, extra) {
      const entries = [...(documentListeners.get(type) || new Map())]
      let stopped = false
      const shared = { ...event(node, extra), stopPropagation() { stopped = true } }
      for (const [listener] of [...entries.filter(([, capture]) => capture), ...entries.filter(([, capture]) => !capture)]) {
        if (stopped) break
        listener(shared)
      }
      render()
    },
    listeners: (type) => documentListeners.get(type)?.size || 0,
    async fire(delay) {
      const entry = [...timers].find(([, timer]) => timer.delay === delay)
      assert.ok(entry, 'expected a pending ' + delay + ' ms timer')
      timers.delete(entry[0])
      entry[1].callback()
      await new Promise((resolve) => setImmediate(resolve))
      render()
    },
    reply(status, payload) {
      const request = pending.shift()
      // A 200 means the (fake) host persisted and normalized the patch.
      if (status === 200) Object.assign(config, request.body, request.body.agents ? { invalidAgents: [] } : {})
      request.resolve(response(status, payload))
    },
    dispose() {
      root = null
      render()
      for (const disposer of disposers.reverse()) disposer?.()
      assert.equal(timers.size, 0, 'unmount and plugin disposal clear all timers')
    },
  }
}

const flattenTree = (node) => {
  if (Array.isArray(node)) return node.flatMap(flattenTree)
  if (node === null || node === undefined || node === false) return []
  return typeof node === 'object' ? [node, ...flattenTree(node.props.children)] : [node]
}

async function editSettings(harness) {
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const organization = harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder')
  harness.change(organization, 'edited-org')
  const refresh = harness.nodes().find((node) => node.type === 'select' && node.props.value === '1200')
  harness.change(refresh, '60')
  const save = harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save'))
  harness.click(save)
  assert.equal(harness.pending.length, 1, 'clicking Save sends one real store request')
  assert.deepEqual(harness.pending[0].body.orgs, ['edited-org'])
  assert.ok(!('agents' in harness.pending[0].body), 'the agent list is not saved unless edited')
  assert.ok(harness.text().includes('settings.saving'), 'pending persistence shows Saving')
  assert.ok(!harness.text().includes('settings.saved'), 'pending persistence must never show Saved')
  assert.ok(!harness.text().includes('settings.done'), 'pending persistence must not mark the form clean')
  assert.equal(harness.store.get().config.orgs.length, 0, 'pending writes leave confirmed config unchanged')
  assert.equal(harness.store.get().pollSeconds, 1200, 'pending writes do not change polling cadence')
}

{
  const harness = settingsHarness()
  await editSettings(harness)
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'), 'confirmed persistence shows Saved')
  assert.ok(harness.text().includes('settings.done'), 'confirmed persistence marks the form clean')
  assert.equal(harness.store.get().config.orgs[0], 'edited-org')
  assert.equal(harness.store.get().pollSeconds, 60, 'confirmed refresh setting updates polling immediately')
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === 60_000), 'confirmed refresh setting schedules its new timer')
  assert.ok(![...harness.timers.values()].some((timer) => timer.delay === 1_200_000), 'confirmed refresh setting cancels its old timer')
  harness.dispose()
}

{
  // A confirmed save reads the snapshot once, without forcing a GitHub scan.
  const harness = settingsHarness()
  await editSettings(harness)
  const reads = harness.host.snapshotReads
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.equal(harness.host.snapshotReads, reads + 1, 'a confirmed save reads the snapshot right away')
  assert.equal(harness.store.get().status, 'ready')
  harness.dispose()
}

{
  // A read in flight at save time started under the old settings: the store
  // reads again once it settles, and only that read sets the poll cadence.
  const harness = settingsHarness()
  await editSettings(harness)
  harness.host.holdSnapshots = true
  void harness.store.load(false)
  const reads = harness.host.snapshotReads
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.equal(harness.host.snapshotReads, reads, 'the post-save read joins the read already in flight')
  assert.equal(harness.host.pendingSnapshots.length, 1)
  harness.host.holdSnapshots = false
  harness.host.pendingSnapshots.shift()()
  await harness.flush()
  assert.equal(harness.host.snapshotReads, reads + 1, 'the pre-save read is followed by a read for the saved settings')
  assert.equal(harness.store.get().status, 'ready')
  assert.equal(harness.store.get().data.settings.refreshSeconds, 60, 'the panel shows the snapshot for the saved settings')
  assert.equal(harness.store.get().pollSeconds, 60)
  harness.dispose()
}

for (const recovers of [true, false]) {
  // A save that fell back to a restart: the first read can 404 before the
  // restarted plugin registered its routes again. It retries once, quietly.
  const label = recovers ? 'retry succeeds' : 'retry fails'
  const harness = settingsHarness()
  await editSettings(harness)
  harness.host.failSnapshots = recovers ? 1 : 2
  const reads = harness.host.snapshotReads
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.equal(harness.host.snapshotReads, reads + 1, label + ': the save reads the snapshot right away')
  assert.notEqual(harness.store.get().status, 'error', label + ': the first failed read after a save is not shown')
  await harness.fire(1500)
  assert.equal(harness.host.snapshotReads, reads + 2, label + ': the failed post-save read is retried once')
  if (recovers) assert.equal(harness.store.get().status, 'ready', label)
  else {
    assert.equal(harness.store.get().status, 'error', label + ': a second failure is shown')
    assert.ok(![...harness.timers.values()].some((timer) => timer.delay === 1500), label + ': no further quick retry')
  }
  harness.dispose()
}

{
  const harness = settingsHarness()
  await editSettings(harness)
  const organization = () => harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder')
  harness.change(organization(), 'newer-unsaved-org')
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.equal(organization().props.value, 'newer-unsaved-org', 'edits made during persistence remain in the form')
  assert.equal(harness.store.get().config.orgs[0], 'edited-org', 'only the submitted edit is confirmed')
  assert.ok(!harness.text().includes('settings.saved'), 'newer unsaved edits must not be described as Saved')
  const saveNewer = harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save'))
  assert.ok(saveNewer && !saveNewer.props.disabled, 'newer edits retain an enabled Save action')
  harness.click(saveNewer)
  assert.deepEqual(harness.pending[0].body.orgs, ['newer-unsaved-org'])
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'), 'saving the newer edit confirms the current form')
  assert.equal(harness.store.get().config.orgs[0], 'newer-unsaved-org')
  harness.dispose()
}

for (const failure of ['host', 'network', 'accepted-save-error']) {
  const harness = settingsHarness()
  await editSettings(harness)
  if (failure === 'network') harness.pending.shift().reject(new Error('connection lost'))
  else if (failure === 'accepted-save-error') {
    // An older host answers 202 before writing; its restarted config reports the failed write.
    harness.reply(202, { ok: true, restarting: true })
    await harness.flush()
    harness.host.saveError = { code: 'save-failed', message: 'disk full' }
    await harness.fire(5000)
    harness.host.saveError = null
  } else harness.reply(500, { ok: false, error: { code: 'save-failed', message: 'disk full' } })
  await harness.flush()
  assert.ok(!harness.text().includes('settings.saved'), failure + ': unconfirmed persistence must not show Saved')
  assert.ok(harness.text().includes('settings.error'), failure + ': failure remains visible')
  assert.equal(harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder').props.value, 'edited-org', 'failed writes preserve form edits')
  const retry = harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save'))
  assert.ok(retry && !retry.props.disabled, 'failed writes leave a dirty, retryable form')
  assert.equal(harness.store.get().config.orgs.length, 0, 'failed writes leave confirmed config unchanged')
  harness.click(retry)
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'), 'a successful retry can show Saved')
  harness.dispose()
}

for (const readBack of ['first', 'retry']) {
  // 202 + ok:true from an older running host: pending notice, then read back.
  const harness = settingsHarness()
  await editSettings(harness)
  harness.reply(202, { ok: true, restarting: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.applying'), readBack + ': an accepted save shows the applying notice')
  assert.ok(!harness.text().includes('settings.saved'), readBack + ': an accepted save is not yet Saved')
  assert.ok(!harness.text().includes('settings.error'), readBack + ': an accepted save is not a failure')
  const saveButton = () => harness.nodes().find((node) => node.type === 'button' && node.props.className === 'adx-btn adx-btn--primary')
  assert.ok(saveButton().props.disabled, readBack + ': Save stays disabled while applying')
  if (readBack === 'retry') {
    harness.host.unavailable = true
    await harness.fire(5000)
    harness.host.unavailable = false
    assert.ok(harness.text().includes('settings.applying'), 'a read during the restart is retried, still applying')
  }
  await harness.fire(5000)
  assert.ok(harness.text().includes('settings.saved'), readBack + ': the read-back config confirms the save')
  assert.ok(harness.text().includes('settings.done'), readBack + ': the confirmed form is clean')
  assert.ok(!harness.text().includes('settings.applying'))
  harness.dispose()
}

{
  // Leaving dirty settings asks first: Back, Cancel and the header gear share the guard.
  const harness = settingsHarness()
  await harness.flush()
  const gear = () => harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings')
  const button = (label) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(label))
  const back = () => harness.nodes().find((node) => node.type === 'button' && node.props.className?.includes('adx-form-head--button'))
  const organization = () => harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder')
  harness.click(gear())
  await harness.flush()
  harness.click(gear())
  assert.equal(harness.store.get().view, 'list', 'a clean form leaves through the gear without asking')
  harness.click(gear())
  await harness.flush()
  harness.change(organization(), 'unsaved-org')
  for (const leave of [gear, back, () => button('settings.cancel')]) {
    harness.click(leave())
    assert.equal(harness.store.get().view, 'settings', 'dirty settings are not left silently')
    assert.ok(harness.text().includes('settings.discardTitle'), 'the discard confirmation is visible')
    assert.ok(harness.nodes().some((node) => node.props?.className === 'adx-leave-confirm' && node.props.role === 'alert'))
    assert.ok(button('settings.discard') && button('settings.keepEditing'))
    harness.click(button('settings.keepEditing'))
    assert.ok(!harness.text().includes('settings.discardTitle'), 'Keep editing hides the confirmation')
    assert.equal(organization().props.value, 'unsaved-org', 'Keep editing preserves the edits')
  }
  harness.click(back())
  harness.change(organization(), '')
  assert.ok(!harness.text().includes('settings.discardTitle'), 'a form that becomes clean drops the confirmation')
  harness.click(back())
  assert.equal(harness.store.get().view, 'list', 'reverting the edit makes leaving direct again')
  harness.click(gear())
  await harness.flush()
  harness.change(organization(), 'unsaved-org')
  harness.click(gear())
  harness.click(button('settings.discard'))
  assert.equal(harness.store.get().view, 'list', 'Discard leaves the settings')
  harness.click(gear())
  await harness.flush()
  assert.equal(organization().props.value, '', 'discarded edits do not come back')
  assert.ok(!harness.text().includes('settings.discardTitle'))
  harness.dispose()
}

{
  // The host checks agent commands on save: an `invalid-agent` answer flags
  // the named row; an older host's plain 400 is a general error.
  const harness = settingsHarness()
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const names = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName' && node.type === 'input')
  const commands = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentCommand')
  const flagged = () => harness.nodes().filter((node) => node.props?.className === 'adx-agent-row')
    .map((node) => node.props['data-invalid'])
  const save = () => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save'))
  const message = 'agent "claude" command must contain {prompt} once, unquoted'

  harness.change(names()[0], '')
  harness.click(save())
  assert.equal(harness.pending.length, 0, 'a nameless agent is still caught before a request')
  assert.ok(harness.text().includes('settings.invalidAgent:claude'), 'the client error names the agent by id')
  assert.deepEqual(flagged(), ['true', 'false'], 'the nameless row is marked')
  harness.change(names()[0], 'Claude Code')
  assert.deepEqual(flagged(), ['false', 'false'], 'editing the marked row clears it')

  harness.change(commands()[0], 'claude "{prompt}"')
  harness.click(save())
  assert.equal(harness.pending.length, 1, 'the command rule is left to the host')
  assert.equal(harness.pending[0].body.agents[0].command, 'claude "{prompt}"')
  harness.reply(400, { ok: false, error: { code: 'invalid-agent', agent: 'claude', message } })
  await harness.flush()
  assert.ok(harness.text().includes('settings.invalidAgentCommand:Claude Code'), 'the rule is explained in the UI language, naming the agent')
  assert.ok(!harness.text().includes(message), 'the host English text is not shown for a named agent')
  assert.deepEqual(flagged(), ['true', 'false'], 'only the agent the host named is flagged')
  assert.ok(harness.text().includes('settings.agentInvalidRow'), 'the flagged row explains itself')
  assert.ok(!harness.text().includes('settings.saved'))
  harness.change(commands()[0], 'claude "{prompt}" --x')
  assert.deepEqual(flagged(), ['false', 'false'], 'editing the flagged row clears it')

  harness.click(save())
  harness.reply(400, { ok: false, error: { code: 'invalid-config', message } })
  await harness.flush()
  assert.ok(harness.text().includes('settings.error: ' + message), 'an older host error is shown as a general error')
  assert.deepEqual(flagged(), ['false', 'false'], 'an older host error flags no row')

  harness.change(commands()[0], 'aider --message={prompt}')
  harness.click(save())
  assert.equal(harness.pending[0].body.agents[0].command, 'aider --message={prompt}')
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'))
  harness.dispose()
}

{
  // An upgraded profile: a saved agent the host now rejects (and omits from
  // config.agents) with a scenario pinned to it.
  const linkScenario = state.config.scenarios[0]
  const pinnedScenario = { ...state.config.scenarios[1], label: 'Pinned review', agent: 'my-claude' }
  const harness = settingsHarness({
    agents: [{ id: 'claude', label: 'Claude Code', command: 'claude {prompt}' }],
    invalidAgents: [{ id: 'my-claude', label: 'My Claude', command: 'claude -p "{prompt}"', reason: 'placeholder' }],
    scenarios: [linkScenario, pinnedScenario],
  })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const names = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName' && node.type === 'input')
  const commands = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentCommand')
  const rows = () => harness.nodes().filter((node) => node.props?.className === 'adx-agent-row')
  const button = (label) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(label))
  assert.deepEqual(names().map((node) => node.props.value), ['Claude Code', 'My Claude'], 'the rejected agent is an editable row')
  assert.equal(commands()[1].props.value, 'claude -p "{prompt}"')
  assert.deepEqual(rows().map((node) => node.props['data-invalid']), ['false', 'true'], 'only the rejected agent is flagged')
  assert.equal(commands()[1].props['aria-invalid'], 'true')
  assert.ok(harness.text().includes('settings.agentUnusableRow'), 'the flagged row explains itself')
  assert.ok(harness.text().includes('settings.agentsUnusable:1'), 'the editor warns about rejected agents')
  // The pinned scenario keeps its agent instead of showing Default.
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.className === 'adx-scenario-toggle'
    && flattenTree(node.props.children).includes('Pinned review')))
  const scenarioAgent = () => harness.nodes().find((node) => node.type === 'select'
    && flattenTree(node.props.children).some((child) => child?.props?.value === 'default'))
  assert.equal(scenarioAgent().props.value, 'my-claude', 'the pinned scenario selects the rejected agent, not Default')
  assert.ok(flattenTree(scenarioAgent().props.children).some((child) => child?.props?.value === 'my-claude' && flattenTree(child.props.children).includes('My Claude')))
  harness.change(harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder'), 'other-edit')
  harness.click(button('settings.save'))
  assert.equal(harness.pending.length, 1, 'an unfixed rejected agent is sent; the host rejects it')
  harness.reply(400, { ok: false, error: { code: 'invalid-agent', agent: 'my-claude', message: 'agent "my-claude" is invalid' } })
  await harness.flush()
  assert.ok(harness.text().includes('settings.invalidAgentCommand:My Claude'), 'the save error explains the rule for the named agent')
  assert.deepEqual(rows().map((node) => node.props['data-invalid']), ['false', 'true'], 'the rejected row stays flagged')
  assert.ok(!harness.text().includes('settings.saved'))
  harness.change(commands()[1], 'claude -p {prompt}')
  assert.equal(rows()[1].props['data-invalid'], 'false', 'a fixed command clears the flag')
  assert.ok(!harness.text().includes('settings.agentsUnusable'), 'the warning clears once every row is usable')
  const readsBefore = harness.host.configReads
  harness.click(button('settings.save'))
  assert.equal(harness.pending.length, 1, 'a fixed command lets the save proceed')
  assert.deepEqual(harness.pending[0].body.agents.map((agent) => [agent.id, agent.command]),
    [['claude', 'claude {prompt}'], ['my-claude', 'claude -p {prompt}']], 'the fixed agent keeps its id')
  assert.ok(harness.pending[0].body.agents.every((agent) => Object.keys(agent).join() === 'id,label,command'), 'row flags are not sent')
  assert.equal(harness.pending[0].body.scenarios[1].agent, 'my-claude', 'the scenario stays pinned to it')
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'))
  assert.equal(harness.host.configReads, readsBefore + 1, 'a confirmed 200 save reads the config back')
  assert.deepEqual(harness.store.get().config.invalidAgents, [], 'the re-read config carries fresh invalidAgents')
  harness.dispose()
}

{
  // A scenario pinned to an agent missing from the form shows it explicitly.
  const harness = settingsHarness({
    agents: [{ id: 'claude', label: 'Claude Code', command: 'claude {prompt}' }],
    scenarios: [state.config.scenarios[0], { ...state.config.scenarios[1], label: 'Orphan', agent: 'gone' }],
  })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.className === 'adx-scenario-toggle'
    && flattenTree(node.props.children).includes('Orphan')))
  const select = harness.nodes().find((node) => node.type === 'select'
    && flattenTree(node.props.children).some((child) => child?.props?.value === 'default'))
  assert.equal(select.props.value, 'gone', 'an unknown pinned agent stays selected')
  assert.ok(flattenTree(select.props.children).includes('settings.scenarioAgentUnknown:gone'), 'it is labelled as unknown')
  harness.change(harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder'), 'dirty')
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save')))
  assert.equal(harness.pending.length, 0, 'an unknown pinned agent blocks saving')
  assert.ok(harness.text().includes('settings.invalidScenarioAgent:Orphan,gone'), 'the error names the scenario and the agent')
  harness.dispose()
}

{
  // Relative times advance with the Page minute tick through memoized Section/Row.
  const generated = Date.parse(snapshot.generatedAt)
  const clock = { now: generated + 5 * 60_000 }
  // A pull request is in one category: counted wins over optional or snoozed
  // when the same id is also listed elsewhere.
  {
    const review = snapshot.sections.find((entry) => entry.id === 'review')
    const respond = snapshot.sections.find((entry) => entry.id === 'respond')
    const both = { ...review.items[0], id: 'pull:77', number: 77, optional: true }
    const sections = snapshot.sections.map((entry) =>
      entry.id === 'review' ? { ...entry, items: [both] }
        : entry.id === 'respond' ? { ...entry, items: [...respond.items, { ...both, section: 'respond', optional: undefined }] }
          : entry)
    const counter = settingsHarness({ snapshotPayload: { ...snapshot, sections } })
    await counter.flush()
    const tip = counter.nodes().find((node) => node.props?.role === 'tooltip')
    const tipText = flattenTree(tip.props.children).filter((node) => typeof node === 'string').join(' ')
    assert.ok(!tipText.includes('count.optional'), 'a counted pull request is not also "not counted": ' + tipText)
    counter.dispose()
  }

  // The header count explains itself: the fixture has 5 actionable items, one
  // pull request in two sections, and one new issue left out.
  {
    const counter = settingsHarness({ snapshotPayload: snapshot })
    await counter.flush()
    const total = counter.nodes().find((node) => node.props?.className === 'adx-total')
    const tip = counter.nodes().find((node) => node.props?.role === 'tooltip')
    assert.ok(total && tip, 'the count has a tooltip')
    assert.equal(total.props.tabIndex, 0, 'the count is reachable by keyboard')
    assert.equal(total.props['aria-describedby'], tip.props.id, 'the tooltip describes the count')
    const tipText = flattenTree(tip.props.children).filter((node) => typeof node === 'string').join(' ')
    assert.ok(tipText.includes('count.title:5'), tipText)
    assert.ok(tipText.includes('count.once'), 'a pull request in two sections is explained')
    assert.ok(tipText.includes('count.excluded:count.issuesOne:1'), tipText)
    const wrap = () => counter.nodes().find((node) => node.props?.className === 'adx-total-wrap')
    const count = () => counter.nodes().find((node) => node.props?.className === 'adx-total')
    let stopped = 0
    count().props.onFocus()
    count().props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped += 1 } })
    await counter.flush()
    assert.equal(wrap().props['data-dismissed'], 'true', 'Escape hides the tooltip')
    assert.equal(stopped, 1, 'the Escape that hides the tooltip does not also leave Select mode')
    count().props.onKeyDown({ key: 'Escape', stopPropagation: () => { stopped += 1 } })
    assert.equal(stopped, 1, 'a later Escape passes through once the tooltip is hidden')
    wrap().props.onMouseLeave()
    await counter.flush()
    assert.equal(wrap().props['data-dismissed'], 'true', 'the pointer leaving keeps a focused count dismissed')
    count().props.onBlur()
    await counter.flush()
    assert.equal(wrap().props['data-dismissed'], 'false', 'leaving the count re-arms it')
    counter.dispose()
  }

  const harness = settingsHarness({ snapshotPayload: snapshot, clock })
  await harness.flush()
  const ages = () => harness.text().match(/time\.minutes:\d+/g) || []
  assert.ok(harness.text().includes('page.updatedAgo:time.minutes:5'), 'header age starts at 5 minutes')
  assert.ok(ages().length > 2 && ages().every((age) => age === 'time.minutes:5'), 'row ages start at 5 minutes')
  clock.now += 2 * 60_000
  await harness.fire(60_000)
  assert.ok(harness.text().includes('page.updatedAgo:time.minutes:7'), 'the header age re-renders on the minute tick')
  assert.ok(ages().every((age) => age === 'time.minutes:7'), 'memoized rows re-render their ages on the tick')
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === 60_000), 'the ticker re-arms itself')
  harness.dispose()
}

{
  // Row and section launch menus: trigger toggling, outside/inside presses,
  // Escape focus return and the row menu's upward flip, driven through the
  // document listeners the real effects register.
  for (const [triggerBottom, flip] of [[100, 'false'], [780, 'true']]) {
    const harness = settingsHarness({ snapshotPayload: snapshot, layout: { innerHeight: 800, menuHeight: 200, triggerBottom } })
    await harness.flush()
    const rowTrigger = () => harness.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === 'launch.title')
    const menu = () => harness.nodes().find((node) => node.props?.className === 'adx-launch-menu')
    harness.click(rowTrigger())
    assert.equal(harness.store.get().openMenu, 'review:pull:1', 'the row trigger opens its menu')
    assert.equal(menu().props['data-flip'], flip, 'the row menu flips upward only without room below')
    assert.equal(harness.listeners('mousedown'), 1, 'one open menu listens for outside presses')
    const firstItem = harness.nodes().find((node) => node.props?.role === 'menuitem')
    assert.equal(harness.focused(), harness.keyOf(firstItem), 'opening focuses the first menu item')
    // A real click on the open trigger is mousedown (ignored by the outside
    // handler) followed by the trigger's own toggle.
    harness.dispatch('mousedown', rowTrigger())
    assert.equal(harness.store.get().openMenu, 'review:pull:1', 'pressing the trigger does not close via the document handler')
    harness.click(rowTrigger())
    assert.equal(harness.store.get().openMenu, null, 'the trigger click toggles the menu closed')
    assert.equal(harness.listeners('mousedown'), 0, 'closing removes the document listeners')
    harness.click(rowTrigger())
    harness.dispatch('mousedown', firstItem)
    assert.equal(harness.store.get().openMenu, 'review:pull:1', 'presses inside the menu keep it open')
    harness.dispatch('mousedown', null)
    assert.equal(harness.store.get().openMenu, null, 'an outside press closes the menu')
    harness.click(rowTrigger())
    harness.dispatch('keydown', null, { key: 'Enter' })
    assert.equal(harness.store.get().openMenu, 'review:pull:1', 'other keys keep the menu open')
    harness.dispatch('keydown', null, { key: 'Escape' })
    assert.equal(harness.store.get().openMenu, null, 'Escape closes the row menu')
    assert.equal(harness.focused(), harness.keyOf(rowTrigger()), 'Escape returns focus to the row trigger')

    const sectionTrigger = () => harness.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === 'launch.sectionTitle')
    harness.click(sectionTrigger())
    assert.equal(harness.store.get().openMenu, 'section:review', 'the section trigger opens its menu')
    harness.dispatch('mousedown', sectionTrigger())
    assert.equal(harness.store.get().openMenu, 'section:review', 'pressing the section trigger is left to its toggle')
    harness.click(sectionTrigger())
    assert.equal(harness.store.get().openMenu, null, 'the section trigger toggles its menu closed')
    harness.click(sectionTrigger())
    harness.dispatch('keydown', null, { key: 'Escape' })
    assert.equal(harness.store.get().openMenu, null, 'Escape closes the section menu')
    assert.equal(harness.focused(), harness.keyOf(sectionTrigger()), 'Escape returns focus to the section trigger')
    harness.click(sectionTrigger())
    harness.click(rowTrigger())
    assert.equal(harness.store.get().openMenu, 'review:pull:1', 'opening a row menu replaces the section menu')
    assert.equal(harness.listeners('mousedown'), 1, 'only the open menu keeps a document listener')
    harness.dispose()
    assert.equal(harness.listeners('mousedown') + harness.listeners('keydown'), 0, 'unmount removes menu listeners')
  }
}

{
  const harness = settingsHarness()
  await harness.flush()
  const button = (label) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(label))
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(button('settings.agentFind'))
  assert.equal(harness.pendingDiscoveries.length, 1, 'Find agents starts one real discovery request')
  assert.deepEqual(harness.pendingDiscoveries[0].body, { commands: ['claude {prompt}', 'codex {prompt}'] },
    'the scan sends the form commands for the host to exclude')
  const agentNames = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName')
  harness.change(agentNames()[0], 'My edited Claude')
  const remove = harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentRemove')
  harness.click(remove[1])
  harness.click(button('settings.agentAdd'))
  harness.change(agentNames()[1], 'My local agent')
  const commands = () => harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentCommand')
  harness.change(commands()[1], 'aider {prompt}')
  harness.change(commands()[0], 'my-claude {prompt}')
  // An older host ignores the commands and returns every installed agent.
  harness.pendingDiscoveries.shift().resolve({
    status: 200, ok: true, json: async () => ({ ok: true, found: [
      { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' },
      { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
      { id: 'claude-alias', label: 'Claude alias', command: 'claude {prompt}' },
      { id: 'aider', label: 'Aider', command: 'aider {prompt}' },
      { id: 'gemini', label: 'Gemini', command: 'gemini {prompt}' },
    ] }),
  })
  await harness.flush()
  assert.deepEqual(agentNames().map((node) => node.props.value), ['My edited Claude', 'My local agent', 'Gemini'],
    'discovery merges into current edits, preserves removals/additions, and deduplicates current commands')
  harness.click(button('settings.save'))
  assert.equal(harness.pending.length, 1, 'merged discovery leaves a valid, saveable form')
  assert.deepEqual(harness.pending[0].body.agents.map((agent) => agent.label), ['My edited Claude', 'My local agent', 'Gemini'])
  assert.deepEqual(harness.pending[0].body.agents.map((agent) => agent.command), ['my-claude {prompt}', 'aider {prompt}', 'gemini {prompt}'],
    'saving preserves edited commands without rediscovering their previous executables')
  harness.reply(200, { ok: true })
  await harness.flush()
  harness.dispose()
}

for (const host of ['current', 'older']) {
  // The current host parses executables, excludes the sent commands' ones and
  // reports `executable`; the client then only drops entries sharing an
  // executable. An older host has neither: exact command strings and the
  // program word are compared (a quoted path with spaces is not split right
  // by that heuristic, so a respelled path can still be added).
  const current = '"/tmp/agent dir/claude" {prompt}'
  const harness = settingsHarness({ agents: [{ id: 'claude', label: 'Existing', command: current }] })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.agentFind')))
  const request = harness.pendingDiscoveries.shift()
  assert.deepEqual(request.body.commands, [current])
  const found = host === 'current'
    ? [
        { id: 'gemini', label: 'Gemini', command: 'gemini {prompt}', executable: 'gemini' },
        { id: 'gemini-alt', label: 'Gemini again', command: 'gemini --x {prompt}', executable: 'gemini' },
        { id: 'codex', label: 'Codex', command: 'codex {prompt}', executable: 'codex' },
      ]
    : [
        { id: 'same', label: 'Same command', command: current },
        { id: 'alias', label: 'Respelled', command: '/tmp/agent\\ dir/claude {prompt}' },
        { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
      ]
  request.resolve({ status: 200, ok: true, json: async () => ({ ok: true, found }) })
  await harness.flush()
  assert.deepEqual(harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName').map((node) => node.props.value),
    host === 'current' ? ['Existing', 'Gemini', 'Codex'] : ['Existing', 'Respelled', 'Codex'],
    host + ' host: discovery deduplication')
  harness.dispose()
}

{
  // An older host returns `claude {prompt}` although `claude --model opus
  // {prompt}` is configured: the program word matches, so no second row.
  const harness = settingsHarness({ agents: [{ id: 'mine', label: 'Opus Claude', command: 'claude --model opus {prompt}' }] })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.agentFind')))
  const request = harness.pendingDiscoveries.shift()
  request.resolve({ status: 200, ok: true, json: async () => ({ ok: true, found: [
    { id: 'claude', label: 'Claude Code', command: 'claude {prompt}' },
    { id: 'codex', label: 'Codex', command: 'FOO=1 codex {prompt}' },
  ] }) })
  await harness.flush()
  assert.deepEqual(harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName').map((node) => node.props.value),
    ['Opus Claude', 'Codex'], 'an older host cannot add a second row for an already configured program')
  harness.dispose()
}

for (const platform of ['win32', 'darwin']) {
  // The program word follows the host's agentExecutable: Windows runs a
  // leading VAR=value word as the program (PowerShell has no such prefix), so
  // `FOO=1 codex` does not configure codex there and discovery may add it.
  const harness = settingsHarness({
    agents: [{ id: 'mine', label: 'Prefixed Codex', command: 'FOO=1 codex {prompt}' }],
    configExtra: { platform },
  })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.agentFind')))
  harness.pendingDiscoveries.shift().resolve({ status: 200, ok: true, json: async () => ({ ok: true, found: [
    { id: 'codex', label: 'Codex', command: 'codex {prompt}' },
  ] }) })
  await harness.flush()
  assert.deepEqual(harness.nodes().filter((node) => node.props?.['aria-label'] === 'settings.agentName').map((node) => node.props.value),
    platform === 'win32' ? ['Prefixed Codex', 'Codex'] : ['Prefixed Codex'], platform + ': the program word of a VAR=value command')
  harness.dispose()
}

for (const labels of [{ sections: { review: 'awaiting my review', rereview: 're-review after changes' }, reasons: { 'review-requested': 'my review requested' } }, undefined]) {
  // The preview uses the host's prompt labels (`config.labels`); an older host
  // has none and the preview shows the codes.
  const harness = settingsHarness({
    scenarios: [state.config.scenarios[0], state.config.scenarios[2]],
    configExtra: labels === undefined ? {} : { labels },
  })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.className === 'adx-scenario-toggle'
    && flattenTree(node.props.children).includes('review-all')))
  const preview = flattenTree(harness.nodes().find((node) => node.type === 'pre').props.children).join('')
  if (labels === undefined) {
    assert.ok(preview.includes('Items: 1 · sections: review ·'), 'an older host previews section codes')
    assert.ok(preview.includes('reason: review-requested'), 'an older host previews reason codes')
  } else {
    assert.ok(preview.includes('Items: 1 · sections: awaiting my review ·'), 'host section labels are previewed')
    assert.ok(preview.includes('reason: my review requested'), 'host reason labels are previewed')
    assert.ok(!preview.includes('changes-after-my-review'), 'the sample represents one group')
  }
  harness.dispose()
}

{
  const harness = settingsHarness({ snapshotPayload: snapshot, prompt: 'Review this pull request', configExtra: {
    supportsEditablePrompt: true, sshServers: [{ alias: 'build', agent: 'claude' }], sshAgents: [{ id: 'claude', label: 'Claude Code' }],
  } })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.title'))
  await harness.flush()
  const field = (name, tag) => flattenTree(harness.nodes().find((node) => node.type === 'label' &&
    node.props.children.includes(name)).props.children).find((node) => node.type === tag)
  assert.equal(field('launch.prompt', 'textarea').props.value, 'Review this pull request')
  harness.change(field('launch.prompt', 'textarea'), 'Review only the schema migration')
  const original = snapshot.sections[0].items[0]
  harness.host.snapshot = { ...snapshot, sections: snapshot.sections.slice(1).map((section) => section.id === 'rereview'
    ? { ...section, items: [...section.items, { ...original, section: section.id }] } : section) }
  await harness.store.load(true)
  await harness.flush()
  assert.equal(field('launch.prompt', 'textarea').props.value, 'Review only the schema migration')
  harness.change(field('launch.machine', 'select'), 'build')
  await harness.flush()
  assert.equal(field('launch.prompt', 'textarea').props.value, 'Review only the schema migration')
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('launch.open')))
  await harness.flush()
  const request = harness.launches.at(-1)
  assert.equal(request.url, '/triage-desk/launch')
  assert.equal(request.body.sshAlias, 'build')
  assert.equal(request.body.agent, 'claude')
  assert.equal(request.body.draft, 'Review only the schema migration')
  assert.equal(request.body.url, original.url)
  assert.equal(request.body.section, 'review')
  harness.dispose()
}

{
  // A section can still open a generic editable draft after its templates are removed.
  const harness = settingsHarness({ snapshotPayload: snapshot, scenarios: [], configExtra: { supportsEditablePrompt: true } })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.sectionTitle'))
  await harness.flush()
  assert.equal(harness.launches[0].body.urls.length, 1)
  assert.ok(harness.nodes().some((node) => node.type === 'textarea' && !node.props.disabled))
  assert.ok(harness.text().includes('(1)'))
  harness.dispose()
}

{
  const harness = settingsHarness({ snapshotPayload: snapshot, configExtra: { supportsEditablePrompt: true } })
  const openGroup = () => harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.sectionTitle'))
  await harness.flush()
  openGroup()
  await harness.flush()
  const prompt = () => harness.nodes().find((node) => node.type === 'textarea')
  const original = harness.launches[0].body.urls
  harness.change(prompt(), 'Review the original group')
  const added = { ...snapshot.sections[1].items[0], section: 'review', reason: 'review-requested' }
  harness.host.snapshot = { ...snapshot, sections: snapshot.sections.map((section) => section.id === 'review'
    ? { ...section, items: [...section.items, added] } : section) }
  await harness.store.load(true)
  await harness.flush()
  assert.equal(prompt().props.value, 'Review the original group')
  assert.ok(harness.text().includes('(1)'), 'the open draft still targets one item')
  assert.equal(harness.launches.length, 1)
  const agent = harness.nodes().find((node) => node.type === 'label' && node.props.children.includes('launch.agent'))
  harness.change(flattenTree(agent.props.children).find((node) => node.type === 'select'), state.config.agents[0].id)
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('launch.open')))
  await harness.flush()
  const launched = harness.launches.at(-1)
  assert.equal(launched.url, '/triage-desk/launch')
  assert.deepEqual(launched.body.urls, original)
  assert.equal(launched.body.draft, 'Review the original group')
  openGroup()
  await harness.flush()
  assert.deepEqual(harness.launches.at(-1).body.urls, [...original, added.url])
  harness.dispose()
}

function labeledControl(harness, label, type = 'select') {
  const field = harness.nodes().find((node) => node.type === 'label' && node.props.children.includes(label))
  return flattenTree(field?.props.children || []).find((node) => node.type === type)
}

const runOnConfig = { supportsRunOn: true, supportsTaskDefault: true, defaultScenario: '', supportsEditablePrompt: true, supportsSshRepositoryFolders: true,
  sshServers: [{ alias: 'builder', agent: 'codex', folders: [], alternatives: [] }],
  sshHosts: ['BUILDER', 'staging'], sshAgents: [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] }

{
  const harness = settingsHarness({ snapshotPayload: snapshot, configExtra: runOnConfig })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.title'))
  await harness.flush()
  const machine = labeledControl(harness, 'launch.machine')
  assert.deepEqual(flattenTree(machine.props.children).filter((node) => node.type === 'option').map((node) => node.props.value),
    ['', 'builder', 'staging'])
  assert.equal(harness.host.probed, undefined)
  harness.host.sshError = 'Connection refused'
  harness.change(machine, 'builder')
  await harness.flush()
  assert.equal(labeledControl(harness, 'launch.agent').props.value, 'codex', 'a failed batch check keeps the saved SSH choice')
  harness.change(labeledControl(harness, 'launch.prompt', 'textarea'), 'Preserve this edit')
  harness.change(machine, 'staging')
  await harness.flush()
  assert.ok(harness.text().includes('Connection refused'))
  assert.ok(flattenTree(labeledControl(harness, 'launch.agent').props.children).some((node) => node.props?.value === 'codex'),
    'an interactive-only host permits a manual agent choice')
  assert.equal(labeledControl(harness, 'launch.agent').props.value, '')
  harness.host.sshError = ''
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('launch.retry')))
  await harness.flush()
  const agent = labeledControl(harness, 'launch.agent')
  harness.change(agent, 'claude')
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('launch.open')))
  await harness.flush()
  assert.deepEqual(harness.host.probed, ['builder', 'staging', 'staging'])
  assert.equal(harness.launches.at(-1).body.sshAlias, 'staging')
  assert.equal(harness.launches.at(-1).body.draft, 'Preserve this edit')
  harness.dispose()
}

{
  const harness = settingsHarness({ configExtra: runOnConfig })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const text = harness.text()
  const groups = harness.nodes().filter((node) => node.type === 'details')
  const github = groups.find((group) => group.props.children[0]?.props.children.includes('settings.githubTitle'))
  assert.ok(github, 'GitHub connection and inbox settings share a single section')
  assert.equal(github.props.open, false, 'connected accounts start collapsed')
  harness.click(github.props.children[0])
  assert.ok(harness.nodes().some((node) => node.type === 'details' && node.props.open &&
    node.props.children[0]?.props.children.includes('settings.githubTitle')))
  const fields = flattenTree(github.props.children)
  for (const key of ['settings.orgs', 'settings.personal', 'settings.refresh', 'settings.green', 'settings.bots']) {
    assert.ok(fields.includes(key), key + ' stays in GitHub')
  }
  assert.ok(text.indexOf('settings.bots') < text.indexOf('settings.agentsSection'))
  const pick = () => labeledControl(harness, 'launch.machine')
  harness.change(labeledControl(harness, 'settings.foldersOn'), 'staging')
  harness.change(labeledControl(harness, 'settings.ssh.folders', 'textarea'), '~/projects')
  harness.host.sshError = 'Authentication requires a terminal'
  harness.change(pick(), 'staging')
  await harness.flush()
  assert.equal(labeledControl(harness, 'settings.defaultAgent').props.value, '', 'folder edits do not assign an agent')
  assert.equal(labeledControl(harness, 'settings.defaultAgent').props.disabled, false)
  harness.host.sshError = ''
  harness.change(pick(), 'builder')
  await harness.flush()
  assert.equal(labeledControl(harness, 'settings.defaultAgent').props.value, 'codex', 'retain a missing preferred agent')
  harness.change(pick(), 'staging')
  await harness.flush()
  assert.ok(harness.text().includes('settings.scenarios'))
  assert.ok(!harness.text().includes('settings.manageAgents'))
  harness.change(labeledControl(harness, 'settings.defaultAgent'), 'claude')
  harness.change(pick(), '')
  assert.ok(harness.text().includes('settings.manageAgents'))
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save')))
  assert.deepEqual(harness.pending[0].body.sshServers.map(({ alias, agent }) => [alias, agent]),
    [['builder', 'codex'], ['staging', 'claude']])
  assert.equal(harness.pending[0].body.defaultAgent, state.config.defaultAgent)
  harness.dispose()
}

{
  const template = { ...state.config.scenarios[1], label: 'Pinned template', agent: 'claude' }
  const harness = settingsHarness({ configExtra: runOnConfig, scenarios: [template] })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.className === 'adx-scenario-toggle'))
  assert.ok(harness.text().includes('settings.localOverride:Claude Code'))
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.useMachineDefault')))
  assert.ok(!harness.text().includes('settings.localOverride'))
  assert.ok(!harness.nodes().some((node) => node.type === 'label' && flattenTree(node.props.children).includes('settings.scenarioAgent')))
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save')))
  assert.equal(harness.pending[0].body.scenarios[0].agent, 'default')
  harness.dispose()
}

function scenarioPicker(harness) {
  return harness.nodes().find((node) => node.type === 'select' && node.props.className === 'adx-select'
    && flattenTree(node.props.children).some((child) => child.type === 'option'))
}
function menuAction(harness, label) {
  return harness.nodes().find((node) => node.props?.role === 'menuitem' && node.props.children.includes(label))
}

{
  const { feedback: feedbackLabel, ...legacySections } = SCENARIO_SECTION_LABELS
  for (const advertisedSections of [legacySections, undefined, { ...legacySections, feedback: feedbackLabel }]) {
    const supportsFeedback = Boolean(advertisedSections?.feedback)
    const hostSections = advertisedSections || legacySections
    const scenarios = defaultScenarios().map((scenario) => ({
      ...scenario,
      sections: scenario.sections.filter((section) => Object.hasOwn(hostSections, section)),
    })).filter((scenario) => scenario.sections.length > 0)
    const harness = settingsHarness({ scenarios, configExtra: {
      labels: advertisedSections && { sections: advertisedSections },
      scenarioDefaults: scenarios, defaultScenario: '',
    } })
    await harness.flush()
    harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
    await harness.flush()
    harness.change(harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder'), 'edited-org')
    harness.click(harness.nodes().find((node) => node.props?.className === 'adx-scenario-toggle'
      && flattenTree(node.props.children).includes('review-pr')))
    const button = (label) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(label))
    assert.ok(button('section.review'), 'the scenario editor offers the existing Review binding')
    const feedback = button('section.feedback')
    assert.equal(Boolean(feedback), supportsFeedback, 'Feedback requires an advertised host binding')
    if (supportsFeedback) harness.click(feedback)
    harness.click(button('settings.save'))
    assert.deepEqual(harness.pending[0].body.orgs, ['edited-org'])
    const savedScenarios = harness.pending[0].body.scenarios
    assert.ok(savedScenarios.every((scenario) => scenario.sections.every((section) => Object.hasOwn(hostSections, section))),
      'the settings save only sends bindings accepted by this host')
    assert.deepEqual(savedScenarios.find((scenario) => scenario.id === 'review-pr').sections,
      supportsFeedback ? ['review', 'feedback'] : ['review'])
    harness.reply(200, { ok: true })
    await harness.flush()
    assert.ok(harness.text().includes('settings.saved'))
    harness.dispose()
  }
}

{
  const harness = settingsHarness({ agents: [], configExtra: { defaultAgent: 'dsh', defaultScenario: '',
    supportsSshRepositoryFolders: true, supportsTaskDefault: true, sshServers: [{ alias: 'old', cwd: '/original', agent: 'claude' }],
    sshAgents: [{ id: 'claude', label: 'Claude' }, { id: 'codex', label: 'Codex' }] } })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  const action = (label) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(label))
  const fields = (label, type) => harness.nodes().filter((node) => node.type === 'label' && node.props.children.includes(label))
    .map((node) => flattenTree(node.props.children).find((child) => child.type === type))
  assert.ok(harness.text().includes('settings.byTask'))
  assert.equal(harness.nodes().find((node) => node.props?.id === 'adx-default-scenario').props.value, '')
  assert.equal(fields('settings.ssh.folders', 'textarea')[0].props.value, '/original')
  harness.click(harness.nodes().filter((node) => node.type === 'button' && node.props.children.includes('settings.scan')).at(-1))
  await harness.flush()
  assert.ok(harness.text().includes('acme/widgets'))
  assert.ok(harness.text().includes('/original/fork'))
  harness.click(action('settings.sshAdd'))
  harness.click(action('settings.sshRemove'))
  harness.change(fields('settings.ssh.alias', 'input')[0], 'build')
  harness.change(fields('settings.ssh.folders', 'textarea')[0], '/work one\n/another')
  harness.change(fields('launch.agent', 'select')[0], 'codex')
  fields('Claude', 'input')[0].props.onChange({ target: { checked: true } })
  await harness.flush()
  harness.click(action('settings.sshAdd'))
  harness.change(fields('settings.ssh.alias', 'input')[1], 'test')
  harness.change(fields('settings.ssh.folders', 'textarea')[1], '/work two')
  harness.click(action('settings.save'))
  assert.equal(harness.pending[0].body.defaultScenario, '')
  assert.deepEqual(harness.pending[0].body.sshServers, [
    { alias: 'build', folders: ['/work one', '/another'], alternatives: ['claude'], agent: 'codex' },
    { alias: 'test', folders: ['/work two'], alternatives: [], agent: 'claude' },
  ])
  harness.dispose()
}

{
  // An assigned issue can appear as a mention in Needs your action. A PR in
  // that same section cannot use the saved issue-triage default.
  const mentioned = { ...snapshot.sections.at(-1).items[0], section: 'respond', reason: 'mentioned', assignees: ['tester'] }
  const sections = snapshot.sections.map((entry) => entry.id === 'respond' ? { ...entry, items: [...entry.items, mentioned] } : entry)
  for (const saved of ['', 'triage-issue']) {
    const harness = settingsHarness({ snapshotPayload: { ...snapshot, sections }, scenarios: defaultScenarios(), configExtra: { defaultScenario: saved } })
    await harness.flush()
    const triggers = () => flattenTree(harness.nodes().find((node) => node.props?.['data-section'] === 'respond').props.children)
      .filter((node) => node.props?.['aria-label'] === 'launch.title')
    harness.click(triggers()[0])
    assert.equal(scenarioPicker(harness).props.value, 'reply-thread')
    assert.ok(!scenarioPicker(harness).props.children.flat().some((node) => node.props.value === 'triage-issue'))
    harness.click(triggers()[1])
    assert.equal(scenarioPicker(harness).props.value, 'triage-issue')
    harness.dispose()
  }
}

{
  const assigned = { ...snapshot.sections.at(-1).items[0], section: 'respond', reason: 'assigned-to-you' }
  const sections = snapshot.sections.map((entry) => entry.id === 'respond' ? { ...entry, items: [assigned] } : entry)
  const url = snapshot.sections[0].items[0].url
  const prompt = 'Custom instructions\n\n' + url
  const writes = []
  const harness = settingsHarness({
    snapshotPayload: { ...snapshot, sections }, scenarios: defaultScenarios(),
    configExtra: { defaultScenario: '' }, agents: [], workspace: null, prompt,
    clipboard: { writeText: async (value) => { writes.push(value) } },
  })
  await harness.flush()
  for (const [section, expected] of [['review', 'review-pr'], ['rereview', 'rereview-pr'],
    ['respond', 'triage-issue'], ['issues', 'triage-issue']]) {
    const panel = harness.nodes().find((node) => node.props?.['data-section'] === section)
    harness.click(flattenTree(panel.props.children).find((node) => node.props?.['aria-label'] === 'launch.title'))
    assert.equal(scenarioPicker(harness).props.value, expected)
    assert.equal(menuAction(harness, 'launch.prepare').props.disabled, true)
    harness.click(menuAction(harness, 'launch.copyPrompt'))
    await harness.flush()
    assert.equal(harness.launches.at(-1).url, '/triage-desk/prompt')
    assert.equal(harness.launches.at(-1).body.scenario, expected)
    assert.equal(harness.store.get().toast.text, 'launch.promptCopied')
    assert.equal(writes.at(-1), prompt)
    harness.dispatch('keydown', null, { key: 'Escape' })
  }
  harness.dispose()

  const fallback = settingsHarness({ snapshotPayload: snapshot, prompt,
    clipboard: { writeText: async () => { throw new Error('denied') } } })
  await fallback.flush()
  fallback.click(fallback.nodes().find((node) => node.props?.['aria-label'] === 'launch.sectionTitle'))
  fallback.click(menuAction(fallback, 'launch.copyPrompt'))
  await fallback.flush()
  assert.equal(fallback.host.selectedText, prompt)
  assert.equal(fallback.focused(), fallback.keyOf(fallback.nodes().find((node) => node.type === 'textarea')))
  fallback.click(menuAction(fallback, 'launch.prepare'))
  await fallback.flush()
  assert.deepEqual(fallback.launches.map((call) => call.url), ['/triage-desk/prompt', '/triage-desk/launch'])
  assert.deepEqual(fallback.launches[0].body, fallback.launches[1].body)
  assert.deepEqual(fallback.launches[0].body.urls, [url], 'copy and prepare include only the first-review group')
  fallback.dispose()
}

{
  const servers = [{ alias: 'first', cwd: '/work/one', agent: 'claude' }, { alias: 'second', cwd: '/work/two', agent: 'codex' }]
  const harness = settingsHarness({ snapshotPayload: snapshot, agents: [], workspace: null,
    configExtra: { sshServers: servers, sshAgents: [{ id: 'codex', label: 'Codex' }], defaultAgent: 'dsh' } })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.title'))
  const picker = harness.nodes().find((node) => node.props?.className?.includes('adx-launch-agent-select'))
  harness.change(picker, 'ssh:second')
  harness.change(scenarioPicker(harness), 'review-pr')
  assert.ok(harness.text().includes('/work/two'))
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches[0].body.sshAlias, 'second')
  assert.equal(harness.launches[0].body.scenario, 'review-pr')
  assert.equal(scenarioPicker(harness).props.value, 'review-pr')
  assert.equal(harness.store.get().toast.text, 'launch.sshConnecting:second,Claude Code')
  harness.dispose()
}

for (const trimmed of [null, { shown: 1, total: 2 }]) {
  const sections = snapshot.sections.map((section) => {
    if (section.id !== 'review') return section
    const item = section.items[0]
    return { ...section, items: [item, { ...item, id: 'pull:99', url: 'https://github.com/tester/example/pull/99' }] }
  })
  const harness = settingsHarness({
    snapshotPayload: { ...snapshot, sections }, trimmed,
    terminal: { id: 'terminal', label: 'Terminal', fallback: true },
    configExtra: { sshServers: [{ alias: 'build', folders: ['/work'], agent: 'claude' }] },
  })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'launch.sectionTitle'))
  harness.change(harness.nodes().find((node) => node.props?.className?.includes('adx-launch-agent-select')), 'ssh:build')
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches[0].body.urls.length, 2)
  assert.equal(harness.store.get().toast.text,
    'launch.sshConnecting:build,Claude Code' + 'launch.terminalFallback' + (trimmed ? 'launch.trimmed:1,2' : ''),
    'SSH confirmation names the destination, flags the terminal fallback and keeps the trimmed count')
  harness.dispose()
}

{
  // Row and section launches through the menus: request bodies and toasts.
  {
    // DSH default (a new profile): a scenario pinned to Codex still runs Codex
    // when the picker is untouched; an unpinned one opens a DSH chat; Settings
    // saves with the DSH default.
    const pinned = { id: 'codex-review', label: 'Codex review', scope: 'item', sections: ['review', 'rereview', 'merge', 'respond', 'ci', 'issues'], prompt: '{url}', agent: 'codex', enabled: true }
    const harness = settingsHarness({
      snapshotPayload: snapshot,
      scenarios: [state.config.scenarios[0], pinned],
      configExtra: { defaultAgent: 'dsh', defaultTarget: 'dsh', effectiveDefaultAgent: 'claude' },
    })
    await harness.flush()
    const rowTrigger = () => harness.nodes().filter((node) => node.type === 'button' && node.props['aria-label'] === 'launch.title')[1]
    harness.click(rowTrigger())
    harness.change(scenarioPicker(harness), 'codex-review')
    harness.click(menuAction(harness, 'launch.prepare'))
    await harness.flush()
    assert.equal(harness.launches[0].url, '/triage-desk/launch', 'a pinned scenario is not overridden by the implicit DSH default')
    assert.equal(harness.launches[0].body.agent, 'codex')
    harness.click(rowTrigger())
    harness.click(menuAction(harness, 'launch.prepare'))
    await harness.flush()
    assert.equal(harness.launches[1].url, '/triage-desk/prompt', 'an unpinned scenario opens the DSH default')
    harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
    await harness.flush()
    harness.change(harness.nodes().find((node) => node.props?.placeholder === 'settings.orgsPlaceholder'), 'edited-org')
    harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save')))
    assert.equal(harness.pending.length, 1, 'a profile with the DSH default can save Settings')
    assert.equal(harness.pending[0].body.defaultAgent, 'dsh')
    harness.dispose()
  }

  const sections = snapshot.sections.map((section) => section.id !== 'rereview' ? section
    : { ...section, items: [{ ...section.items[0], rereviewCause: 'author-reply' }] })
  const harness = settingsHarness({ snapshotPayload: { ...snapshot, sections } })
  await harness.flush()
  const picker = () => harness.nodes().find((node) => node.type === 'select' && node.props.className?.includes('adx-launch-agent-select'))
  const rowTrigger = () => harness.nodes().filter((node) => node.type === 'button' && node.props['aria-label'] === 'launch.title')[1]
  harness.click(rowTrigger())
  assert.equal(harness.store.get().openMenu, 'rereview:pull:2')
  assert.equal(picker().props.value, 'claude', 'the default agent is preselected')
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches.length, 1)
  assert.equal(harness.launches[0].url, '/triage-desk/launch')
  assert.equal(harness.launches[0].body.reason, 'author-replied', 'a terminal launch sends the author-replied reason')
  assert.equal(harness.launches[0].body.agent, undefined,
    'an untouched picker sends no agent: the host resolves the default with fresh detection')
  assert.equal(harness.store.get().openMenu, null, 'a successful launch closes the menu')
  assert.equal(harness.store.get().toast.text, 'launch.draft:Claude Code,iTerm2,/work,⌘V')
  harness.click(rowTrigger())
  harness.change(picker(), 'dsh')
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches[1].url, '/triage-desk/prompt')
  assert.equal(harness.launches[1].body.reason, 'author-replied', 'a DSH draft sends the author-replied reason')
  assert.equal(harness.store.get().toast.text, 'launch.dshDraft')
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === 'launch.sectionTitle'))
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.deepEqual(harness.launches[2].body, {
    scenario: 'review-all', section: 'review',
    urls: ['https://github.com/tester/example/pull/1'],
  }, 'the review action sends only the visible first review')
  assert.equal(harness.store.get().toast.text, 'launch.draft:Claude Code,iTerm2,/work,⌘V')
  harness.dispose()
}

{
  // Terminal choice and prompt delivery: Settings shows this platform's
  // terminals (uninstalled ones disabled), the delivery cards with a warning
  // when typing prompts in is not possible, saves both, and the launch menu
  // says where the agent opens and how it gets the prompt.
  const configExtra = {
    platform: 'linux',
    terminal: 'auto',
    promptDelivery: 'paste',
    terminals: {
      platform: 'linux',
      auto: 'gnome-terminal',
      autoLabel: 'GNOME Terminal',
      options: [
        { id: 'gnome-terminal', label: 'GNOME Terminal', tabs: true, available: true },
        { id: 'ghostty', label: 'Ghostty', tabs: false, available: true },
        { id: 'kitty', label: 'kitty', tabs: false, available: false },
      ],
    },
    promptPaste: { available: true, reason: null },
  }
  const linkOnly = state.config.scenarios.filter((scenario) => scenario.id === 'link')
  const harness = settingsHarness({ snapshotPayload: snapshot, scenarios: linkOnly, configExtra })
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const terminalSelect = () => harness.nodes().find((node) => node.type === 'select' && node.props.id === 'adx-terminal')
  const options = flattenTree(terminalSelect().props.children).filter((node) => node?.type === 'option')
  assert.deepEqual(options.map((node) => node.props.value), ['auto', 'gnome-terminal', 'ghostty', 'kitty'])
  assert.equal(flattenTree(options[0].props.children).join(''), 'settings.terminalAuto:GNOME Terminal')
  assert.equal(options[3].props.disabled, true, 'an uninstalled terminal cannot be picked')
  assert.ok(harness.text().includes('settings.terminalTabs:GNOME Terminal'), 'automatic explains tabs')
  harness.change(terminalSelect(), 'ghostty')
  assert.ok(harness.text().includes('settings.terminalWindows:Ghostty'), 'Ghostty on Linux opens windows')
  const card = (value) => harness.nodes().find((node) => node.props?.role === 'radio' && node.props['data-value'] === value)
  assert.equal(card('paste').props['aria-checked'], 'true', 'typing into the agent is the default')
  assert.ok(harness.text().includes('settings.deliveryClipboardHint:Ctrl+Shift+V'), 'the Linux paste keys are shown')
  harness.click(card('clipboard'))
  assert.equal(card('clipboard').props['aria-checked'], 'true')
  harness.click(harness.nodes().find((node) => node.type === 'button' && node.props.children.includes('settings.save')))
  assert.equal(harness.pending.length, 1)
  assert.equal(harness.pending[0].body.terminal, 'ghostty')
  assert.equal(harness.pending[0].body.promptDelivery, 'clipboard')
  harness.dispose()

  // Without a usable Python the paste card warns, and a codex launch says clipboard.
  const blocked = settingsHarness({
    snapshotPayload: snapshot,
    configExtra: { ...configExtra, platform: 'darwin', promptPaste: { available: false, reason: 'python-clt' } },
  })
  await blocked.flush()
  blocked.click(blocked.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await blocked.flush()
  assert.ok(blocked.text().includes('settings.pasteUnavailable.python-clt'), 'the missing-tools warning is shown')
  blocked.dispose()

  const menu = settingsHarness({ snapshotPayload: snapshot, configExtra })
  await menu.flush()
  menu.click(menu.nodes().filter((node) => node.type === 'button' && node.props['aria-label'] === 'launch.title')[0])
  assert.ok(menu.text().includes('launch.via.draft:GNOME Terminal'), 'Claude Code opens with its native draft')
  const picker = menu.nodes().find((node) => node.type === 'select' && node.props.className?.includes('adx-launch-agent-select'))
  menu.change(picker, 'codex')
  assert.ok(menu.text().includes('launch.via.paste:GNOME Terminal'), 'Codex gets the prompt typed in')
  menu.dispose()

  // The host's `detectedAgents[id].draft` decides when present (above it is
  // absent and the draft flag decides): `false` for a Windows `.cmd` shim.
  // Absent on Windows (no host verdict, e.g. a failed probe) means no draft.
  for (const [name, claude, via] of [
    ['draft: true', { available: true, path: 'C:\\bin\\claude.exe', executable: 'claude', draft: true }, 'draft'],
    ['draft: false', { available: true, path: 'C:\\npm\\claude.cmd', executable: 'claude', draft: false }, 'paste'],
    ['draft absent', { available: null, path: null, reason: 'probe-failed', executable: 'claude' }, 'paste'],
  ]) {
    const windowsMenu = settingsHarness({
      snapshotPayload: snapshot,
      configExtra: { ...configExtra, platform: 'win32', detectedAgents: { claude } },
    })
    await windowsMenu.flush()
    windowsMenu.click(windowsMenu.nodes().filter((node) => node.type === 'button' && node.props['aria-label'] === 'launch.title')[0])
    assert.ok(windowsMenu.text().includes('launch.via.' + via + ':GNOME Terminal'), name + ' → ' + via)
    windowsMenu.dispose()
  }
}

/* -------------------------------------------- attention badge, counts, snooze */

const tester = { kind: 'user', login: 'tester' }
const acme = { kind: 'org', login: 'acme' }
const pull = (section, number, extra = {}) => ({
  id: 'acme/app#' + number, kind: 'pull', section, source: tester, repo: 'acme/app', number, title: 'PR ' + number,
  url: 'https://github.com/acme/app/pull/' + number, author: { login: 'octo' }, updatedAt: '2026-01-01T09:00:00.000Z',
  reason: 'review-requested', checks: { state: 'success', total: 0, failing: [] }, ...extra,
})
const branchItem = {
  ...pull('ci', 0), id: 'tester@acme/app@main', kind: 'branch', number: undefined, ref: 'main', title: 'main',
  url: 'https://github.com/acme/app/commits/main', commit: 'c1',
}
const inbox = (overrides = {}) => ({
  ok: true, status: 'ok', generatedAt: '2026-01-01T10:00:00.000Z', sources: [tester, acme],
  settings: { refreshSeconds: 1200 }, warnings: [], meta: {},
  sections: [
    { id: 'review', items: overrides.review ?? [pull('review', 1), pull('review', 2, { optional: true }), pull('review', 3, { source: acme })] },
    { id: 'rereview', items: overrides.rereview ?? [] },
    { id: 'feedback', items: overrides.feedback ?? [] },
    { id: 'merge', items: [pull('merge', 5, { source: acme })] },
    { id: 'respond', items: overrides.respond ?? [pull('respond', 4)] },
    { id: 'ci', items: overrides.ci ?? [pull('ci', 4), branchItem] },
    { id: 'issues', items: [{ ...pull('issues', 9), id: 'acme/app#9', kind: 'issue', url: 'https://github.com/acme/app/issues/9' }] },
  ],
  ...(overrides.status ? { status: overrides.status } : {}),
})
const memoryStorage = (initial = {}) => {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value) },
    removeItem: (key) => { delete data[key] },
  }
}
const fixAll = { id: 'fix-all', label: 'Fix all', scope: 'section', sections: ['respond', 'ci'], prompt: '{links}', agent: 'default', enabled: true }
function inboxView(harness) {
  const nodes = harness.nodes()
  const chip = (label) => {
    const node = nodes.find((entry) => entry.props?.className === 'adx-chip' && flattenTree(entry.props.children).includes(label))
    return node ? flattenTree(node.props.children).find((child) => child?.props?.className === 'adx-chip-count').props.children[0] : null
  }
  const textOf = (className) => {
    const node = nodes.find((entry) => entry.props?.className === className)
    return node ? flattenTree(node.props.children).join('') : null
  }
  return {
    badge: textOf('adx-badge'),
    badgeHint: nodes.find((entry) => entry.props?.className === 'adx-icon-wrap' && 'title' in entry.props)?.props.title,
    total: textOf('adx-total'),
    all: chip('page.filterAll'),
    chip: (id) => chip('section.' + id),
    rows: nodes.filter((node) => node.props?.className === 'adx-row')
      .map((row) => flattenTree(row.props.children).find((child) => child?.props?.className === 'adx-row-title').props.children[0]),
    snoozedRows: nodes.filter((node) => node.props?.className === 'adx-row' && node.props['data-snoozed'] === 'true').length,
    snoozedChip: nodes.find((node) => node.props?.className === 'adx-chip adx-chip--snoozed'),
    snoozedChipCount: (() => {
      const node = nodes.find((entry) => entry.props?.className === 'adx-chip adx-chip--snoozed')
      return node ? flattenTree(node.props.children).find((child) => child?.props?.className === 'adx-chip-count').props.children[0] : null
    })(),
    toast: nodes.find((node) => node.props?.className === 'adx-toast'),
  }
}
const rowButton = (harness, title, label, nth = 0) => {
  const row = harness.nodes().filter((node) => node.props?.className === 'adx-row'
    && flattenTree(node.props.children).includes(title))[nth]
  return flattenTree(row.props.children).find((node) => node.type === 'button' && node.props['aria-label'] === label)
}

{
  const harness = settingsHarness({ snapshotPayload: inbox({
    rereview: [pull('rereview', 8, { reason: 're-review-requested' }), pull('rereview', 9, { optional: true })],
    feedback: [pull('feedback', 4, { reason: 'changes-requested' }), pull('feedback', 6, { draft: true, reason: 'review-feedback' })],
    respond: [pull('respond', 7, { reason: 'conflict' })],
  }), scenarios: defaultScenarios(), configExtra: { defaultScenario: '' }, withPanel: true })
  await harness.flush()
  const chip = (id) => harness.nodes().find((node) => node.props?.className === 'adx-chip'
    && flattenTree(node.props.children).includes('section.' + id))
  assert.equal(inboxView(harness).chip('reviews'), '7')
  harness.click(chip('reviews'))
  assert.deepEqual(inboxView(harness).rows, ['PR 1', 'PR 2', 'PR 3', 'PR 8', 'PR 9', 'PR 4', 'PR 6'])
  assert.equal(inboxView(harness).total, '8', 'feedback and CI on PR 4 count once')
  harness.click(rowButton(harness, 'PR 8', 'launch.title'))
  assert.equal(scenarioPicker(harness).props.value, 'rereview-pr')
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches[0].body.scenario, 'rereview-pr')
  assert.equal(harness.launches[0].body.reason, 're-review-requested')
  harness.click(chip('feedback'))
  assert.deepEqual(inboxView(harness).rows, ['PR 4', 'PR 6'])
  assert.ok(harness.nodes().some((node) => node.type === 'a' && node.props.href.endsWith('/4/files')
    && node.props.children.includes('action.addressChanges')))
  assert.ok(harness.nodes().some((node) => node.type === 'a' && node.props.href.endsWith('/6#issuecomment-new')
    && node.props.children.includes('action.reply')))
  harness.click(rowButton(harness, 'PR 4', 'snooze.button'))
  harness.click(harness.nodes().find((node) => node.props?.['data-choice'] === 'activity'))
  assert.deepEqual(inboxView(harness).rows, ['PR 6'])
  assert.equal(inboxView(harness).chip('reviews'), '6')
  assert.equal(inboxView(harness).total, '7', 'one snooze hides feedback and CI together')
  harness.dispose()
}

{
  // Badge: actionable items once each, optional review requests left out;
  // every list count follows the source filter and the search.
  const harness = settingsHarness({ snapshotPayload: inbox(), withPanel: true })
  await harness.flush()
  let view = inboxView(harness)
  assert.equal(view.badge, '5', 'the badge counts #1, #3, #4 (respond + ci once), #5 and the branch; not the optional #2 or issues')
  assert.equal(view.total, '5', 'the header total matches the badge')
  assert.equal(view.badgeHint, undefined, 'the sidebar badge adds no tooltip next to DSH\'s own panel tooltip')
  assert.ok(harness.nodes().some((node) => node.type === 'path' && node.props.d === 'M9 7H15V9H9L10 8Z'),
    'the sidebar shows the Triage Desk mark (the selected row of the prompt queue)')
  assert.equal(view.all, '8', 'All counts the rows the list shows')
  assert.equal(view.chip('reviews'), '3')
  assert.equal(view.chip('ci'), '2')
  harness.store.set({ sourceFilter: 'org:acme' })
  await harness.flush()
  view = inboxView(harness)
  assert.deepEqual(view.rows, ['PR 3', 'PR 5'])
  assert.equal(view.all, '2', 'the All chip follows the source filter')
  assert.equal(view.chip('reviews'), '1', 'section chips follow the source filter')
  assert.equal(view.chip('respond'), null, 'a section without rows for the source has no chip')
  assert.equal(view.total, '2', 'the header total follows the source filter')
  assert.equal(view.badge, '5', 'the sidebar badge stays global')
  harness.store.set({ sourceFilter: 'all' })
  await harness.flush()
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'PR 4')
  view = inboxView(harness)
  assert.deepEqual(view.rows, ['PR 4', 'PR 4'])
  assert.equal(view.all, '2', 'chip counts follow the search')
  assert.equal(view.chip('respond'), '1')
  assert.equal(view.chip('reviews'), null)
  harness.dispose()
}

// Wednesday 7 January 2026, 15:30 local time: "tomorrow" is Thursday 09:00,
// "next week" is Monday 12 January 09:00.
const snoozeNow = new Date(2026, 0, 7, 15, 30).getTime()
const localTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
const tomorrowAt = new Date(2026, 0, 8, 9, 0).getTime()
const mondayAt = new Date(2026, 0, 12, 9, 0).getTime()
const snoozeChoice = (harness, title, choice, nth = 0) => {
  harness.click(rowButton(harness, title, 'snooze.button', nth))
  harness.click(harness.nodes().find((node) => node.props?.role === 'menuitem' && node.props['data-choice'] === choice))
}
const sectionMenuItem = (harness, sectionId, label) => {
  const section = harness.nodes().find((node) => node.props?.['data-section'] === sectionId)
  harness.click(flattenTree(section.props.children).find((node) => node.type === 'button' && node.props['aria-label'] === 'launch.sectionTitle'))
  assert.ok(flattenTree(scenarioPicker(harness).props.children).some((child) => typeof child === 'string' && child.startsWith(label)))
  return menuAction(harness, 'launch.prepare')
}
const itemLabel = (harness) => flattenTree(scenarioPicker(harness).props.children).find((child) => typeof child === 'string' && child.startsWith('Fix all'))

{
  // The snooze popover behaves like the launch menu.
  for (const [triggerBottom, flip] of [[100, 'false'], [780, 'true']]) {
    const harness = settingsHarness({
      snapshotPayload: inbox(), clock: { now: snoozeNow }, layout: { innerHeight: 800, menuHeight: 200, triggerBottom },
    })
    await harness.flush()
    const trigger = () => rowButton(harness, 'PR 4', 'snooze.button')
    harness.click(trigger())
    assert.equal(harness.store.get().openMenu, 'snooze:respond:acme/app#4', 'the clock opens the snooze menu of that row')
    const menu = harness.nodes().find((node) => node.props?.role === 'menu')
    assert.equal(menu.props['aria-label'], 'snooze.menu')
    assert.equal(menu.props['data-flip'], flip, 'the snooze menu flips upward only without room below')
    assert.equal(trigger().props['aria-expanded'], 'true')
    const row = harness.nodes().find((node) => node.props?.className === 'adx-row' && node.props['data-menu-open'] === 'true')
    assert.ok(flattenTree(row.props.children).includes('PR 4'), 'the row with the open snooze menu is lifted')
    const items = harness.nodes().filter((node) => node.props?.role === 'menuitem')
    assert.deepEqual(items.map((node) => node.props['data-choice']), ['activity', 'tomorrow', 'next-week'], 'until new activity comes first')
    assert.equal(harness.focused(), harness.keyOf(items[0]), 'opening focuses the first choice')
    const texts = items.map((node) => flattenTree(node.props.children).filter((child) => typeof child === 'string'))
    assert.deepEqual(texts[0], ['snooze.activity', 'snooze.activityHint'])
    assert.deepEqual(texts[1], ['snooze.tomorrowOption', 'snooze.tomorrow:' + localTime(tomorrowAt)], 'tomorrow shows its local time')
    assert.deepEqual(texts[2], ['snooze.nextWeekOption',
      'snooze.on:' + new Date(mondayAt).toLocaleDateString(undefined, { weekday: 'short' }) + ',' + localTime(mondayAt)],
    'next week shows Monday and its local time')
    assert.ok(harness.text().includes('snooze.note'), 'the menu says new activity returns items sooner')
    harness.dispatch('mousedown', trigger())
    assert.equal(harness.store.get().openMenu, 'snooze:respond:acme/app#4', 'pressing the trigger is left to its toggle')
    harness.dispatch('keydown', null, { key: 'Escape' })
    assert.equal(harness.store.get().openMenu, null, 'Escape closes the snooze menu')
    assert.equal(harness.focused(), harness.keyOf(trigger()), 'Escape returns focus to the clock')
    harness.click(trigger())
    harness.dispatch('mousedown', null)
    assert.equal(harness.store.get().openMenu, null, 'an outside press closes the snooze menu')
    harness.click(trigger())
    harness.click(trigger())
    assert.equal(harness.store.get().openMenu, null, 'the clock toggles its menu closed')
    assert.equal(harness.listeners('mousedown'), 0)
    harness.dispose()
  }
}

{
  // Snoozing: id-level hiding, Undo, timed snoozes ending on time and early on
  // new activity, the Snoozed view, section launches and pruning.
  const storage = memoryStorage()
  const stored = () => JSON.parse(storage.data['triage-desk:snoozed:v2'] || '{}')
  const clock = { now: snoozeNow }
  const harness = settingsHarness({
    snapshotPayload: inbox(), withPanel: true, storage, clock, scenarios: [state.config.scenarios[0], fixAll],
  })
  await harness.flush()
  assert.equal(inboxView(harness).snoozedChip, undefined, 'no Snoozed chip without snoozed items')

  snoozeChoice(harness, 'PR 4', 'activity')
  let view = inboxView(harness)
  assert.equal(harness.store.get().openMenu, null, 'picking a choice closes the menu')
  assert.ok(!view.rows.includes('PR 4'), 'a snoozed item leaves every section it was listed in')
  assert.equal(view.badge, '4', 'a snoozed item leaves the badge')
  assert.equal(view.all, '6')
  assert.deepEqual(stored(), { 'acme/app#4': { fingerprint: '2026-01-01T09:00:00.000Z', until: null, at: new Date(snoozeNow).toISOString() } },
    'v2 entries keep the fingerprint, the end and the snooze time')
  assert.equal(view.toast.props.role, 'status')
  assert.deepEqual(flattenTree(view.toast.props.children).filter((child) => typeof child === 'string'), ['snooze.toastActivity', 'snooze.undo'],
    'the toast names the snooze and offers Undo')
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === 6000), 'a toast with an action stays 6 s')
  harness.click(flattenTree(view.toast.props.children).find((node) => node.type === 'button'))
  view = inboxView(harness)
  assert.ok(view.rows.includes('PR 4'), 'Undo brings the item back')
  assert.deepEqual(stored(), {}, 'Undo restores the previous (absent) entry')
  assert.equal(view.toast, undefined, 'Undo closes the toast')
  assert.ok(![...harness.timers.values()].some((timer) => timer.delay === 6000), 'Undo cancels the toast timer')

  snoozeChoice(harness, 'PR 4', 'activity')
  const fixAllItem = sectionMenuItem(harness, 'ci', 'Fix all')
  assert.equal(itemLabel(harness), 'Fix all (1)', 'the section action leaves out snoozed items')
  harness.click(fixAllItem)
  await harness.flush()
  assert.deepEqual(harness.launches.at(-1).body.urls, ['https://github.com/acme/app/commits/main'], 'a section launch never includes snoozed items')
  harness.store.unsnooze('acme/app#4')
  await harness.flush()

  // Timed snooze: shown in the Snoozed view with its return time, ends on time.
  harness.click(harness.nodes().find((node) => node.props?.className === 'adx-chip' && flattenTree(node.props.children).includes('section.ci')))
  snoozeChoice(harness, 'PR 4', 'tomorrow')
  view = inboxView(harness)
  assert.equal(flattenTree(view.toast.props.children).find((child) => typeof child === 'string'),
    'snooze.toastUntil:snooze.tomorrow:' + localTime(tomorrowAt), 'the toast names the return time')
  assert.equal(stored()['acme/app#4'].until, new Date(tomorrowAt).toISOString())
  assert.ok([...harness.timers.values()].some((timer) => timer.delay === tomorrowAt - snoozeNow), 'the store waits for the snooze end')
  assert.equal(view.snoozedChipCount, '1')
  assert.equal(view.snoozedChip.props['aria-pressed'], 'false')
  harness.click(view.snoozedChip)
  view = inboxView(harness)
  assert.equal(harness.store.get().filter, 'snoozed')
  assert.equal(view.snoozedChip.props['aria-pressed'], 'true', 'the Snoozed chip is a toggle')
  assert.deepEqual(view.rows, ['PR 4', 'PR 4'], 'the Snoozed view lists only snoozed items, grouped by section')
  assert.equal(view.snoozedRows, 2, 'snoozed rows are muted')
  assert.equal(view.all, '6', 'other counts still exclude snoozed items')
  assert.ok(harness.text().includes('snooze.returnsAt:snooze.tomorrow:' + localTime(tomorrowAt)), 'rows say when they return')
  assert.equal(rowButton(harness, 'PR 4', 'snooze.button'), undefined, 'Unsnooze replaces the clock')
  sectionMenuItem(harness, 'ci', 'Fix all')
  assert.equal(itemLabel(harness), 'Fix all (0)', 'section launches never take snoozed rows')
  harness.dispatch('keydown', null, { key: 'Escape' })
  harness.click(rowButton(harness, 'PR 4', 'snooze.unsnooze'))
  assert.equal(harness.store.get().filter, 'ci', 'unsnoozing the last item returns to the previous filter')
  assert.equal(inboxView(harness).snoozedChip, undefined)
  assert.deepEqual(stored(), {})
  assert.ok(![...harness.timers.values()].some((timer) => timer.delay === tomorrowAt - snoozeNow), 'no snooze end is pending')
  harness.click(harness.nodes().find((node) => node.props?.className === 'adx-chip' && flattenTree(node.props.children).includes('page.filterAll')))

  snoozeChoice(harness, 'PR 1', 'tomorrow')
  harness.click(inboxView(harness).snoozedChip)
  assert.ok(harness.text().includes('snooze.returnsAt:snooze.tomorrow:'))
  clock.now = tomorrowAt - 60_000
  await harness.fire(60_000)
  assert.ok(harness.text().includes('snooze.returnsAt:snooze.today:' + localTime(tomorrowAt)), 'the return label follows the minute tick')
  clock.now = tomorrowAt
  await harness.fire(tomorrowAt - snoozeNow)
  view = inboxView(harness)
  assert.equal(view.badge, '5', 'a timed snooze returns to the badge on time, without a refresh')
  assert.equal(harness.store.get().filter, 'all', 'the Snoozed view closes when nothing is snoozed any more')
  assert.ok(view.rows.includes('PR 1'))
  assert.deepEqual(stored(), {}, 'an expired snooze is pruned')

  // A timed snooze also ends on new activity; plain ones too.
  snoozeChoice(harness, 'main', 'next-week')
  snoozeChoice(harness, 'PR 4', 'activity')
  assert.equal(inboxView(harness).badge, '3')
  harness.host.snapshot = inbox({ status: 'partial', respond: [pull('respond', 4, { updatedAt: '2026-01-08T10:00:00.000Z' })],
    ci: [pull('ci', 4, { updatedAt: '2026-01-08T10:00:00.000Z' }), { ...branchItem, commit: 'c2' }] })
  await harness.store.load(false)
  await harness.flush()
  view = inboxView(harness)
  assert.deepEqual(view.rows.filter((title) => title === 'PR 4' || title === 'branch.title:main'), ['PR 4', 'PR 4', 'branch.title:main'],
    'new activity (updatedAt, branch commit) ends timed and activity snoozes')
  assert.deepEqual(stored(), {}, 'changed items are pruned from any snapshot')

  snoozeChoice(harness, 'PR 1', 'activity')
  harness.host.snapshot = inbox({ status: 'partial', review: [pull('review', 3, { source: acme })] })
  await harness.store.load(false)
  await harness.flush()
  assert.deepEqual(Object.keys(stored()), ['acme/app#1'], 'a partial snapshot never prunes missing items')
  harness.host.snapshot = inbox({ status: 'stale', review: [] })
  await harness.store.load(false)
  await harness.flush()
  assert.deepEqual(Object.keys(stored()), ['acme/app#1'], 'a stale snapshot never prunes missing items')
  harness.host.snapshot = inbox({ review: [pull('review', 3, { source: acme })] })
  await harness.store.load(false)
  await harness.flush()
  assert.deepEqual(stored(), {}, 'an ok snapshot prunes snoozes of items that are gone')
  harness.dispose()
}

{
  // The Snoozed chip count follows the source filter and the search.
  const harness = settingsHarness({ snapshotPayload: inbox(), clock: { now: snoozeNow } })
  await harness.flush()
  snoozeChoice(harness, 'PR 1', 'activity')
  snoozeChoice(harness, 'PR 3', 'next-week')
  assert.equal(inboxView(harness).snoozedChipCount, '2')
  harness.store.set({ sourceFilter: 'org:acme' })
  await harness.flush()
  assert.equal(inboxView(harness).snoozedChipCount, '1', 'the Snoozed count follows the source filter')
  harness.store.set({ sourceFilter: 'all' })
  await harness.flush()
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'PR 1')
  assert.equal(inboxView(harness).snoozedChipCount, '1', 'the Snoozed count follows the search')
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'nothing')
  assert.equal(inboxView(harness).snoozedChip, undefined, 'no chip when the search leaves no snoozed item')
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), '')
  harness.click(inboxView(harness).snoozedChip)
  for (const filter of ['all', 'review', 'merge', 'ci']) {
    harness.store.set({ filter })
    await harness.flush()
    assert.equal(inboxView(harness).snoozedRows, 0, 'normal views never show snoozed rows: ' + filter)
  }
  harness.dispose()
}

{
  // Stored v2 snoozes survive a reload; an expired one does not apply and is pruned.
  const v2 = memoryStorage({ 'triage-desk:snoozed:v2': JSON.stringify({
    'acme/app#5': { fingerprint: '2026-01-01T09:00:00.000Z', until: new Date(tomorrowAt).toISOString(), at: '' },
    'acme/app#1': { fingerprint: '2026-01-01T09:00:00.000Z', until: new Date(snoozeNow - 1).toISOString(), at: '' },
    'acme/app#3': { fingerprint: 7 },
  }) })
  const reloaded = settingsHarness({ snapshotPayload: inbox(), withPanel: true, storage: v2, clock: { now: snoozeNow } })
  await reloaded.flush()
  assert.ok(!inboxView(reloaded).rows.includes('PR 5'), 'a pending timed snooze applies after a reload')
  assert.ok(inboxView(reloaded).rows.includes('PR 1'), 'an expired snooze does not hide the item')
  assert.ok(inboxView(reloaded).rows.includes('PR 3'), 'a malformed entry is ignored')
  assert.deepEqual(Object.keys(JSON.parse(v2.data['triage-desk:snoozed:v2'])), ['acme/app#5'], 'the expired entry is pruned')
  reloaded.dispose()

  {
    // A timed snooze that ends while the panel is open returns the item to
    // the sidebar badge on its next render, even with no store data change.
    const clock = { now: snoozeNow }
    const soon = memoryStorage({ 'triage-desk:snoozed:v2': JSON.stringify({
      'acme/app#5': { fingerprint: '2026-01-01T09:00:00.000Z', until: new Date(snoozeNow + 60_000).toISOString(), at: '' },
    }) })
    const ticking = settingsHarness({ snapshotPayload: inbox(), withPanel: true, storage: soon, clock })
    await ticking.flush()
    const before = Number(inboxView(ticking).badge)
    clock.now += 3 * 60_000
    ticking.store.set({ toast: null, copied: 'x' })
    await ticking.flush()
    assert.equal(Number(inboxView(ticking).badge), before + 1, 'the expired snooze counts again in the badge')
    ticking.dispose()
  }

  for (const broken of [
    { getItem() { throw new Error('SecurityError') }, setItem() { throw new Error('QuotaExceededError') } },
    { getItem: () => '{not json', setItem() { throw new Error('QuotaExceededError') }, removeItem() {} },
    undefined,
  ]) {
    const harness = settingsHarness({ snapshotPayload: inbox(), withPanel: true, storage: broken, clock: { now: snoozeNow } })
    await harness.flush()
    snoozeChoice(harness, 'PR 1', 'activity')
    assert.ok(!inboxView(harness).rows.includes('PR 1'), 'snoozing works without usable storage')
    assert.equal(inboxView(harness).badge, '4')
    harness.dispose()
  }
}

/* ----------------------------------------------------- bulk snooze, selection */

const rowNodes = (harness, title) => harness.nodes().filter((node) => node.props?.className === 'adx-row'
  && flattenTree(node.props.children).includes(title))
const checkbox = (harness, title, nth = 0) => flattenTree(rowNodes(harness, title)[nth].props.children)
  .find((node) => node.props?.role === 'checkbox')
const selectedTitles = (harness) => harness.nodes().filter((node) => node.props?.className === 'adx-row' && node.props['data-selected'] === 'true')
  .map((row) => flattenTree(row.props.children).find((child) => child?.props?.className === 'adx-row-title').props.children[0])
const selectionBar = (harness) => harness.nodes().find((node) => node.props?.className === 'adx-selection-bar')
const barButton = (harness, label) => flattenTree(selectionBar(harness).props.children)
  .find((node) => node.type === 'button' && flattenTree(node.props.children).includes(label))
const sectionButton = (harness, sectionId, labelPrefix) => {
  const section = harness.nodes().find((node) => node.props?.['data-section'] === sectionId)
  return section ? flattenTree(section.props.children)
    .find((node) => node.type === 'button' && String(node.props['aria-label'] || '').startsWith(labelPrefix)) : undefined
}
const pickChoice = (harness, choice) => harness.click(harness.nodes().find((node) => node.props?.role === 'menuitem' && node.props['data-choice'] === choice))
const toastText = (harness) => {
  const toast = harness.nodes().find((node) => node.props?.className === 'adx-toast')
  return toast ? flattenTree(toast.props.children).find((child) => typeof child === 'string') : null
}
const undo = (harness) => harness.click(flattenTree(harness.nodes().find((node) => node.props?.className === 'adx-toast').props.children)
  .find((node) => node.type === 'button'))

{
  // Section snooze: the section's visible rows under the source filter and
  // search, one toast and one Undo; the Snoozed view unsnoozes a section.
  const storage = memoryStorage()
  const stored = () => JSON.parse(storage.data['triage-desk:snoozed:v2'] || '{}')
  const harness = settingsHarness({ snapshotPayload: inbox(), withPanel: true, storage, clock: { now: snoozeNow } })
  await harness.flush()
  harness.store.set({ sourceFilter: 'user:tester' })
  await harness.flush()
  const trigger = sectionButton(harness, 'review', 'snooze.section')
  assert.equal(trigger.props['aria-label'], 'snooze.section:2', 'the section button counts the visible rows (PR 1, PR 2)')
  harness.click(trigger)
  assert.equal(harness.store.get().openMenu, 'snooze-section:review')
  const menu = harness.nodes().find((node) => node.props?.role === 'menu')
  assert.equal(menu.props['aria-label'], 'snooze.menuMany:2', 'the same popover, titled with the count')
  assert.equal(harness.focused(), harness.keyOf(harness.nodes().find((node) => node.props?.role === 'menuitem')), 'first choice focused')
  assert.equal(harness.nodes().find((node) => node.props?.className === 'adx-section-head' && node.props['data-menu-open'] === 'true') !== undefined, true,
    'the section head with the open popover is lifted')
  pickChoice(harness, 'tomorrow')
  assert.deepEqual(Object.keys(stored()).sort(), ['acme/app#1', 'acme/app#2'], 'only the visible rows of the section are snoozed')
  assert.equal(stored()['acme/app#1'].until, new Date(tomorrowAt).toISOString())
  assert.equal(toastText(harness), 'snooze.toastManyUntil:2,snooze.tomorrow:' + localTime(tomorrowAt), 'one toast for the bulk snooze')
  assert.equal(sectionButton(harness, 'review', 'snooze.section'), undefined, 'a section without visible rows has no button')
  undo(harness)
  assert.deepEqual(stored(), {}, 'one Undo restores every entry')

  harness.store.set({ sourceFilter: 'all' })
  await harness.flush()
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'PR 4')
  harness.click(sectionButton(harness, 'respond', 'snooze.section:1'))
  assert.equal(harness.nodes().find((node) => node.props?.role === 'menu').props['aria-label'], 'snooze.menu', 'one row: the plain title')
  pickChoice(harness, 'activity')
  assert.deepEqual(Object.keys(stored()), ['acme/app#4'], 'the search narrows the section snooze')
  assert.equal(toastText(harness), 'snooze.toastActivity')
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), '')

  harness.click(sectionButton(harness, 'review', 'snooze.section:3'))
  pickChoice(harness, 'activity')
  const before = stored()
  assert.deepEqual(Object.keys(before).sort(), ['acme/app#1', 'acme/app#2', 'acme/app#3', 'acme/app#4'])
  harness.click(inboxView(harness).snoozedChip)
  assert.equal(sectionButton(harness, 'review', 'snooze.section'), undefined, 'the Snoozed view has no section snooze')
  const unsnoozeAll = sectionButton(harness, 'review', 'snooze.unsnoozeAll')
  assert.equal(unsnoozeAll.props['aria-label'], 'snooze.unsnoozeAll:3')
  harness.click(unsnoozeAll)
  assert.deepEqual(Object.keys(stored()), ['acme/app#4'], 'Unsnooze all acts on that section only')
  assert.equal(toastText(harness), 'snooze.toastUnsnoozedMany:3')
  undo(harness)
  assert.deepEqual(stored(), before, 'Undo restores the exact previous entries')
  harness.dispose()
}

const selectToggle = (harness) => harness.nodes().find((node) => node.type === 'button' && String(node.props.className).includes('adx-select-toggle'))
const headerCheckbox = (harness, sectionId) => {
  const section = harness.nodes().find((node) => node.props?.['data-section'] === sectionId)
  return flattenTree(section.props.children).find((node) => node.props?.role === 'checkbox' && String(node.props['aria-label']).startsWith('select.section'))
}
const barText = (harness) => flattenTree(selectionBar(harness).props.children.find((child) => child?.props?.className === 'adx-selection-count').props.children).join('')
const allRows = (harness) => harness.nodes().filter((node) => node.props?.className === 'adx-row')

{
  const copied = []
  const prepared = []
  const prompt = '- PR 8, reason: new commits since my review\n- PR 10, reason: author replied to me'
  const harness = settingsHarness({
    snapshotPayload: inbox({
      review: [
        null, pull('review', 1), pull('review', 1), undefined,
        pull('review', 2, { optional: true }), pull('review', 3, { source: acme }),
      ],
      rereview: [
        pull('rereview', 8, { rereviewCause: 'new-head', reason: 'changes-after-my-review' }),
        pull('rereview', 10, { rereviewCause: 'author-reply', reason: 'author-replied' }),
        pull('rereview', 9, { optional: true }),
      ],
      feedback: [pull('feedback', 6)],
    }),
    prompt,
    clipboard: { writeText: async (text) => { copied.push(text) } },
    workspace: { startSession: (_id, draft) => { prepared.push(draft.prompt) } },
    scenarios: defaultScenarios(),
    configExtra: { defaultTarget: 'dsh', defaultScenario: '' },
  })
  await harness.flush()
  const draft = async (group, label, numbers) => {
    const action = sectionMenuItem(harness, group, label)
    assert.ok(action, group + ' menu offers ' + label)
    harness.click(action)
    await harness.flush()
    assert.equal(harness.launches.at(-1).url, '/triage-desk/prompt')
    assert.equal(harness.launches.at(-1).body.section, group)
    assert.deepEqual(harness.launches.at(-1).body.urls, numbers.map((n) => 'https://github.com/acme/app/pull/' + n))
  }
  assert.ok(flattenTree(rowNodes(harness, 'PR 2')[0].props.children).includes('meta.optionalReview'))
  harness.click(rowButton(harness, 'PR 8', 'launch.title'))
  assert.equal(scenarioPicker(harness).props.value, 'rereview-pr')
  harness.click(menuAction(harness, 'launch.prepare'))
  await harness.flush()
  assert.equal(harness.launches.at(-1).body.reason, 'changes-after-my-review')
  await draft('review', 'launch.review:2', [1, 3])
  await draft('rereview', 'launch.rereview:2', [8, 10])
  const prepare = harness.launches.at(-1)
  assert.equal(prepare.body.scenario, 'review-all')
  sectionMenuItem(harness, 'rereview', 'launch.rereview:2')
  harness.click(menuAction(harness, 'launch.copyPrompt'))
  await harness.flush()
  assert.deepEqual(harness.launches.at(-1), prepare, 'both re-review actions request the same group draft')
  assert.equal(copied.at(-1), prepared.at(-1))
  assert.equal(copied.at(-1), prompt)
  harness.dispatch('keydown', null, { key: 'Escape' })
  await draft('feedback', 'launch.replyFeedbackOne:1', [6])
  harness.store.set({ sourceFilter: 'user:tester' })
  await harness.flush()
  await draft('review', 'launch.reviewOne:1', [1])
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'PR 2')
  assert.equal(sectionMenuItem(harness, 'review', 'launch.review:0').props.disabled, true)
  harness.click(selectToggle(harness))
  harness.click(checkbox(harness, 'PR 2'))
  await draft('review', 'launch.reviewOne:1', [2])
  harness.dispose()
}

for (const target of ['dsh', 'claude']) {
  const harness = settingsHarness({
    snapshotPayload: inbox(), scenarios: defaultScenarios(), configExtra: { defaultTarget: target },
    trimmed: { shown: 1, total: 2 },
  })
  await harness.flush()
  harness.click(sectionMenuItem(harness, 'review', 'launch.review:2'))
  await harness.flush()
  const toast = harness.store.get().toast.text
  assert.ok(toast.endsWith('launch.trimmed:1,2'), target + ' reports how many items reached the draft')
  assert.ok(!toast.includes('launch.countSuffix'), 'a trimmed draft shows a single count')
  harness.dispose()
}

{
  // Select mode: explicit entry, a checkbox column before the glyph, rows that
  // select instead of navigating, section tri-state, Select all, Escape order.
  const harness = settingsHarness({ snapshotPayload: inbox(), withPanel: true, clock: { now: snoozeNow } })
  await harness.flush()
  assert.equal(harness.nodes().filter((node) => node.props?.role === 'checkbox').length, 0, 'no checkbox outside Select mode')
  assert.ok(allRows(harness).every((row) => flattenTree(row.props.children).some((node) => node.props?.className === 'adx-row-glyph')),
    'rows keep their type glyph')
  assert.ok(allRows(harness).every((row) => row.props.onClick === undefined), 'rows do not select outside Select mode')
  assert.equal(selectionBar(harness), undefined)
  assert.equal(selectToggle(harness).props['aria-pressed'], 'false')
  assert.ok(flattenTree(selectToggle(harness).props.children).includes('select.enter'))

  harness.click(selectToggle(harness))
  assert.equal(selectToggle(harness).props['aria-pressed'], 'true')
  const row1 = () => rowNodes(harness, 'PR 1')[0]
  const rowChildren = flattenTree(row1().props.children)
  assert.ok(rowChildren.findIndex((node) => node.props?.className === 'adx-row-select')
    < rowChildren.findIndex((node) => node.props?.className === 'adx-row-glyph'), 'the checkbox column comes before the glyph')
  assert.equal(checkbox(harness, 'PR 1').props['aria-label'], 'select.row:PR 1', 'the checkbox names its row')
  assert.equal(checkbox(harness, 'PR 1').props['aria-checked'], 'false')
  const title = rowChildren.find((node) => node.props?.className === 'adx-row-title')
  assert.equal(title.type, 'span', 'the title is not a link in Select mode')
  assert.equal(title.props.href, undefined)
  for (const label of ['launch.title', 'snooze.button', 'page.copy', 'launch.sectionTitle']) {
    assert.equal(harness.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === label), undefined, 'hidden in Select mode: ' + label)
  }
  assert.equal(sectionButton(harness, 'review', 'snooze.section'), undefined, 'no section snooze in Select mode')
  assert.ok(sectionButton(harness, 'review', 'page.collapse'), 'the chevron stays')
  assert.equal(headerCheckbox(harness, 'review').props['aria-label'], 'select.section:section.review')
  assert.equal(headerCheckbox(harness, 'review').props['aria-checked'], 'false')
  assert.equal(barText(harness), 'select.hint', 'the bar is shown with a hint before anything is selected')
  assert.ok(barButton(harness, 'select.done'))
  assert.equal(barButton(harness, 'snooze.button'), undefined)

  harness.click(row1())
  assert.deepEqual(selectedTitles(harness), ['PR 1'], 'a row click selects')
  assert.equal(checkbox(harness, 'PR 1').props['aria-checked'], 'true')
  assert.equal(headerCheckbox(harness, 'review').props['aria-checked'], 'mixed', 'the header is indeterminate')
  assert.equal(barText(harness), 'select.count:1')
  harness.click(rowNodes(harness, 'PR 3')[0], { shiftKey: true })
  assert.deepEqual(selectedTitles(harness), ['PR 1', 'PR 2', 'PR 3'], 'Shift+click selects the range in visible order')
  assert.equal(headerCheckbox(harness, 'review').props['aria-checked'], 'true')
  harness.click(headerCheckbox(harness, 'review'))
  assert.deepEqual(selectedTitles(harness), [], 'the checked header clears its section')
  harness.click(headerCheckbox(harness, 'review'))
  assert.deepEqual(selectedTitles(harness), ['PR 1', 'PR 2', 'PR 3'], 'the header selects its whole section')
  harness.click(checkbox(harness, 'PR 4', 1))
  assert.deepEqual(selectedTitles(harness), ['PR 1', 'PR 2', 'PR 3', 'PR 4', 'PR 4'], 'a PR in two sections is one selection')
  assert.equal(barText(harness), 'select.count:4', 'the bar counts items, not rows')
  harness.click(barButton(harness, 'select.all'))
  assert.equal(barText(harness), 'select.count:7', 'Select all takes every visible item across sections')
  harness.click(barButton(harness, 'select.none'))
  assert.equal(barText(harness), 'select.hint')

  harness.click(row1())
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), 'PR')
  assert.deepEqual(Object.keys(harness.store.get().selected), [], 'a search change clears the selection')
  assert.equal(harness.store.get().selectMode, true, '... and keeps Select mode')
  harness.click(row1())
  harness.store.set({ sourceFilter: 'user:tester' })
  await harness.flush()
  assert.deepEqual(Object.keys(harness.store.get().selected), [], 'a source change clears the selection')
  harness.store.set({ sourceFilter: 'all' })
  harness.change(harness.nodes().find((node) => node.props?.type === 'search'), '')
  await harness.flush()

  harness.click(row1())
  harness.click(rowNodes(harness, 'PR 3')[0])
  harness.host.snapshot = inbox({ review: [pull('review', 3, { source: acme })] })
  await harness.store.load(false)
  await harness.flush()
  assert.deepEqual(selectedTitles(harness), ['PR 3'], 'a refresh keeps the ids it still shows')
  harness.click(barButton(harness, 'snooze.button'))
  harness.dispatch('keydown', null, { key: 'Escape' })
  assert.equal(harness.store.get().openMenu, null, 'Escape closes the bar popover first')
  assert.equal(harness.store.get().selectMode, true)
  assert.deepEqual(selectedTitles(harness), ['PR 3'])
  // Escape with the pointer over the count closes its hint, not Select mode.
  const countWrap = () => harness.nodes().find((node) => node.props?.className === 'adx-total-wrap')
  countWrap().props.onMouseEnter()
  await harness.flush()
  harness.dispatch('keydown', null, { key: 'Escape' })
  assert.equal(countWrap().props['data-dismissed'], 'true', 'Escape hides the hovered hint')
  assert.equal(harness.store.get().selectMode, true, 'the hint Escape does not leave Select mode')
  countWrap().props.onMouseLeave()
  await harness.flush()
  harness.dispatch('keydown', null, { key: 'Escape' })
  assert.equal(harness.store.get().selectMode, false, 'Escape then leaves Select mode')
  assert.equal(harness.nodes().filter((node) => node.props?.role === 'checkbox').length, 0)
  assert.equal(selectionBar(harness), undefined)
  assert.equal(harness.listeners('keydown'), 0, 'no Escape listener outside Select mode')

  harness.click(selectToggle(harness))
  harness.click(barButton(harness, 'select.done'))
  assert.equal(harness.store.get().selectMode, false, 'Done leaves Select mode')
  harness.click(selectToggle(harness))
  harness.click(selectToggle(harness))
  assert.equal(harness.store.get().selectMode, false, 'the pressed Select button leaves the mode too')
  harness.dispose()
}

{
  // Bulk actions from the bar end Select mode with one Undo; the Snoozed view unsnoozes.
  const storage = memoryStorage()
  const stored = () => JSON.parse(storage.data['triage-desk:snoozed:v2'] || '{}')
  const harness = settingsHarness({ snapshotPayload: inbox(), withPanel: true, storage, clock: { now: snoozeNow } })
  await harness.flush()
  harness.click(selectToggle(harness))
  harness.click(rowNodes(harness, 'PR 1')[0])
  harness.click(rowNodes(harness, 'PR 3')[0])
  harness.click(rowNodes(harness, 'PR 5')[0])
  harness.click(barButton(harness, 'snooze.button'))
  const menu = harness.nodes().find((node) => node.props?.role === 'menu')
  assert.equal(menu.props['aria-label'], 'snooze.menuMany:3')
  assert.equal(menu.props['data-flip'], 'true', 'the bar popover opens upward')
  pickChoice(harness, 'next-week')
  assert.deepEqual(Object.keys(stored()).sort(), ['acme/app#1', 'acme/app#3', 'acme/app#5'])
  assert.equal(stored()['acme/app#5'].until, new Date(mondayAt).toISOString())
  assert.equal(harness.store.get().selectMode, false, 'a bulk snooze ends Select mode')
  assert.equal(selectionBar(harness), undefined)
  assert.equal(inboxView(harness).badge, '2')
  assert.ok(toastText(harness).startsWith('snooze.toastManyUntil:3,'))
  undo(harness)
  assert.deepEqual(stored(), {}, 'one Undo restores all three')
  assert.equal(inboxView(harness).badge, '5')

  harness.click(selectToggle(harness))
  harness.click(rowNodes(harness, 'PR 1')[0])
  harness.click(rowNodes(harness, 'PR 3')[0])
  harness.click(barButton(harness, 'snooze.button'))
  pickChoice(harness, 'activity')
  assert.equal(toastText(harness), 'snooze.toastManyActivity:2')
  harness.click(inboxView(harness).snoozedChip)
  harness.click(selectToggle(harness))
  assert.equal(barText(harness), 'select.hintUnsnooze', 'the Snoozed view hint')
  assert.equal(barButton(harness, 'select.all'), undefined, 'nothing selected: only the hint and Done')
  harness.click(rowNodes(harness, 'PR 1')[0])
  harness.click(barButton(harness, 'select.all'))
  assert.equal(barText(harness), 'select.count:2')
  assert.equal(barButton(harness, 'snooze.button'), undefined, 'the Snoozed view bar does not snooze')
  harness.click(barButton(harness, 'snooze.unsnooze'))
  assert.deepEqual(stored(), {}, 'the bar unsnoozes the selection')
  assert.equal(harness.store.get().selectMode, false, 'a bulk unsnooze ends Select mode')
  assert.equal(toastText(harness), 'snooze.toastUnsnoozedMany:2')
  assert.equal(harness.store.get().filter, 'all', 'the empty Snoozed view closes')
  harness.dispose()
}

for (const mode of ['dir', 'clone']) {
  const harness = settingsHarness()
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const button = (key) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(key))
  const field = (id) => harness.nodes().find((node) => node.props?.id === id)
  const id = mode === 'dir' ? 'adx-clone-dirs' : 'adx-repo-paths'
  harness.change(field(id), mode === 'dir' ? '/old-root' : 'owner/old = /old-clone')
  harness.click(button(mode === 'dir' ? 'settings.pickFolder' : 'settings.pickClone'))
  assert.equal(harness.pendingPickers.length, 1, 'opening a native picker sends one request')
  harness.change(field(id), mode === 'dir' ? '/edited-root\n/picked-root' : 'owner/new = /edited-clone\nowner/picked \t = /old-picked-clone')
  harness.pendingPickers.shift().resolve({
    status: 200, ok: true,
    json: async () => mode === 'dir'
      ? { ok: true, path: '/picked-root' }
      : { ok: true, repo: 'owner/picked', path: '/picked-clone' },
  })
  await harness.flush()
  const expected = mode === 'dir' ? '/edited-root\n/picked-root' : 'owner/new = /edited-clone\nowner/picked = /picked-clone'
  assert.equal(field(id).props.value, expected, mode + ': picker merges into current edits without resurrecting deleted paths')
  harness.click(button('settings.save'))
  assert.deepEqual(harness.pending[0].body[mode === 'dir' ? 'cloneDirs' : 'repoPaths'], mode === 'dir'
    ? ['/edited-root', '/picked-root']
    : { 'owner/new': '/edited-clone', 'owner/picked': '/picked-clone' })
  harness.reply(200, { ok: true })
  await harness.flush()
  harness.dispose()
}

for (const invalid of ['owner/broken /missing-equals', ' = /missing-repository', 'owner/broken = ']) {
  const harness = settingsHarness()
  await harness.flush()
  harness.click(harness.nodes().find((node) => node.props?.['aria-label'] === 'page.settings'))
  await harness.flush()
  const button = (key) => harness.nodes().find((node) => node.type === 'button' && node.props.children.includes(key))
  const field = () => harness.nodes().find((node) => node.props?.id === 'adx-repo-paths')
  const text = 'owner/valid = /valid-clone\n \t\n' + invalid
  harness.change(field(), text)
  harness.click(button('settings.save'))
  assert.equal(harness.pending.length, 0, 'malformed mapping must block persistence instead of silently deleting it: ' + invalid)
  assert.ok(harness.text().includes('settings.invalidRepoPaths:3'), 'validation identifies the invalid line, counting blank lines')
  assert.equal(field().props.value, text, 'failed validation preserves all mapping text for repair')
  assert.ok(!button('settings.save').props.disabled, 'invalid mapping remains dirty and repairable')
  harness.change(field(), 'owner/valid = /valid-clone\n \t\nowner/repaired = /path/with=equals')
  harness.click(button('settings.save'))
  assert.equal(harness.pending.length, 1, 'repairing the line allows saving')
  assert.deepEqual(harness.pending[0].body.repoPaths, {
    'owner/valid': '/valid-clone', 'owner/repaired': '/path/with=equals',
  }, 'valid mappings and equals characters inside paths survive the repair')
  harness.reply(200, { ok: true })
  await harness.flush()
  assert.ok(harness.text().includes('settings.saved'), 'repaired mappings can be confirmed saved')
  harness.dispose()
}

console.log('render smoke OK (%d bytes of markup; settings success/202/failure/discard guard/discovery/pickers/validation, minute tick and menu interactions exercised)', html.length)
