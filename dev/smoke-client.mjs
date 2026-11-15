/**
 * Dev smoke test for the client half: loads client.js against a fake module
 * loader and a fake Cordis context, then prints the slot registrations.
 * Run with `npm run smoke:client`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))
const registry = []
globalThis.window = {
  __ModuleLoader__: {
    load: (registration) => registry.push(registration),
  },
}

const fakeReact = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
  memo: (component) => component,
}
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('unexpected require: ' + name)
}

const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')
new Function('window', 'require', source)(globalThis.window, fakeRequire)

const registration = registry[0]
if (!registration || typeof registration.factory !== 'function') {
  throw new Error('client bundle did not register a factory')
}
const plugin = registration.factory(fakeRequire)
if (typeof plugin.apply !== 'function' || !Array.isArray(plugin.inject)) {
  throw new Error('client bundle did not return a plugin with apply/inject')
}

const registrations = []
const dictionaries = {}
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
    register: (_namespace, language, dictionary) => {
      dictionaries[language] = dictionary
      return () => {}
    },
    bind: () => (key) => key,
  },
}
plugin.apply(fakeCtx)

for (const entry of registrations) {
  const identity = entry.options.key || entry.options.id
  if (!identity || typeof entry.component !== 'function') {
    throw new Error('invalid slot registration: ' + JSON.stringify(entry.options))
  }
  console.log(`slot ${entry.options.name} -> ${identity}`)
}
if (registrations.length !== 2) {
  throw new Error('expected a sidebar panel and a main page registration')
}

/* ------------------------------------------------------------- dictionaries */

const languages = ['en', 'zh']
for (const language of languages) {
  assert.ok(dictionaries[language] !== undefined, `missing ${language} dictionary`)
}
const baseKeys = new Set(Object.keys(dictionaries.en))
console.log(`dictionary keys: ${baseKeys.size}`)
for (const language of languages) {
  const keys = new Set(Object.keys(dictionaries[language]))
  const missing = [...baseKeys].filter((key) => !keys.has(key))
  const extra = [...keys].filter((key) => !baseKeys.has(key))
  assert.deepEqual(missing, [], `${language} is missing keys: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `${language} has extra keys: ${extra.join(', ')}`)
}

const placeholders = (value) => new Set([...String(value).matchAll(/{([A-Za-z0-9_-]+)}/g)].map((match) => match[1]))
for (const key of baseKeys) {
  const reference = dictionaries.en[key]
  assert.ok(typeof reference === 'string' && reference.trim() !== '', `en.${key} is empty`)
  const expected = placeholders(reference)
  for (const language of languages) {
    const actual = placeholders(dictionaries[language][key])
    assert.deepEqual(
      [...actual].sort(),
      [...expected].sort(),
      `placeholders differ for ${key} in ${language}`,
    )
  }
}

// Every literal t('key') in the bundle must exist in every dictionary.
const sourcePath = path.join(here, '..', 'client.js')
const bundleSource = fs.readFileSync(sourcePath, 'utf8')
const referenced = new Set(
  [...bundleSource.matchAll(/\bt\('([^']+)'/g)]
    .map((match) => match[1])
    .filter((key) => !key.endsWith('.')),
)
const absent = [...referenced].filter((key) => !baseKeys.has(key))
assert.deepEqual(absent, [], `t() keys missing from dictionaries: ${absent.join(', ')}`)
console.log(`checked ${referenced.size} literal t() keys`)

// Exercise the real apply/slot-injected store lifecycle with browser boundaries
// faked. No store implementation is extracted, rewritten, or reimplemented.
const flush = () => new Promise((resolve) => setImmediate(resolve))
function lifecycleHarness({
  deferSnapshots = false, transientSnapshot = false, outcome = () => 'ok', configPost = () => ({ status: 200, payload: { ok: true } }),
} = {}) {
  const pendingSnapshots = []
  const pendingConfigs = []
  let now = 1_000_000
  let sequence = 0
  const timers = new Map()
  const events = new globalThis.EventTarget()
  const visibilityListeners = new Set()
  const document = {
    // Styles already installed by the host are outside this lifecycle test.
    querySelector: () => ({}),
    visibilityState: 'visible',
    addEventListener(type, callback) {
      if (type === 'visibilitychange') visibilityListeners.add(callback)
      events.addEventListener(type, callback)
    },
    removeEventListener(type, callback) {
      if (type === 'visibilitychange') visibilityListeners.delete(callback)
      events.removeEventListener(type, callback)
    },
  }
  const requests = []
  const slots = []
  const disposers = []
  let refreshSeconds = 1200
  const sandbox = {
    console,
    document,
    Date: class extends Date { static now() { return now } },
    setTimeout(callback, delay) {
      const id = ++sequence
      timers.set(id, { callback, at: now + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    fetch: async (url, options) => {
      if (url === '/triage-desk/config' && options.method === 'GET') {
        return new Promise((resolve, reject) => pendingConfigs.push({ resolve, reject }))
      }
      if (url === '/triage-desk/config' && options.method === 'POST') {
        const { status, payload } = configPost()
        return { status, ok: status >= 200 && status < 300, json: async () => payload }
      }
      requests.push(url)
      assert.equal(url.split('?')[0], '/triage-desk/snapshot')
      const result = outcome(requests.length)
      if (result === 'throw') throw new Error('connection lost')
      if (result === 'http500') return { ok: false, status: 500, json: async () => null }
      const payload = {
        sections: [], settings: { refreshSeconds },
        ...(transientSnapshot ? { status: 'partial', warnings: [{ message: 'inactive context' }] } : {}),
        ...(result === 'error' ? { status: 'error', error: { code: 'gh-network', message: 'offline' } } : {}),
        ...(result === 'stale' ? { status: 'stale', meta: { lastError: { code: 'network', message: 'offline' } } } : {}),
        ...(result === 'stale-transient'
          ? { status: 'stale', warnings: [{ message: 'refresh failed: inactive context' }] }
          : {}),
      }
      const response = { ok: true, json: async () => payload }
      if (deferSnapshots) return new Promise((resolve) => pendingSnapshots.push(() => resolve(response)))
      return response
    },
  }
  sandbox.window = {
    ...sandbox,
    __ModuleLoader__: {
      load(registration) {
        registration.factory(fakeRequire).apply({
          ...fakeCtx,
          effect(callback) { disposers.push(callback()) },
          slots: {
            inject: (_key, callback) => callback(),
            register(options) { slots.push(options); return () => {} },
          },
        })
      },
    },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const store = slots.find((slot) => slot.name === 'main').inject().store
  return {
    store, requests, timers, visibilityListeners,
    resolveSnapshot() { assert.ok(pendingSnapshots.length > 0); pendingSnapshots.shift()() },
    resolveConfig(config) {
      assert.ok(pendingConfigs.length > 0)
      pendingConfigs.shift().resolve({ status: 200, ok: true, json: async () => ({ config }) })
    },
    rejectConfig(error) { assert.ok(pendingConfigs.length > 0); pendingConfigs.shift().reject(error) },
    setInterval(seconds) { refreshSeconds = seconds },
    visibility(value) {
      document.visibilityState = value
      events.dispatchEvent(new globalThis.Event('visibilitychange'))
    },
    async advance(milliseconds) {
      const target = now + milliseconds
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
        if (!next || next[1].at > target) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await flush()
      }
      now = target
      await flush()
    },
    dispose() { for (const disposer of disposers.reverse()) disposer?.() },
  }
}

{
  const harness = lifecycleHarness()
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  assert.equal(harness.requests.length, 1, 'first subscriber loads a snapshot')
  harness.visibility('hidden')
  await harness.advance(1_200_000)
  assert.equal(harness.requests.length, 1, 'hidden tabs do not poll')
  harness.visibility('visible')
  await flush()
  assert.equal(harness.requests.length, 2, 'returning to a visible tab refreshes immediately')
  assert.equal(harness.visibilityListeners.size, 1, 'one visibility listener belongs to the subscribed store')
  const unsubscribeSidebar = harness.store.subscribe(() => {})
  unsubscribe()
  assert.equal(harness.visibilityListeners.size, 1, 'another mounted slot keeps the listener alive')
  unsubscribeSidebar()
  assert.equal(harness.visibilityListeners.size, 0, 'last unmount removes the visibility listener')
  assert.equal(harness.timers.size, 0, 'last unmount cancels polling')
  harness.visibility('hidden')
  harness.visibility('visible')
  await harness.advance(1_200_000)
  assert.equal(harness.requests.length, 2, 'unmounted slots do not request more snapshots')
  const unsubscribeAgain = harness.store.subscribe(() => {})
  await flush()
  assert.equal(harness.requests.length, 3, 'remount resumes loading')
  harness.dispose()
  unsubscribeAgain()
  assert.equal(harness.visibilityListeners.size, 0, 'plugin disposal removes the listener')
  assert.equal(harness.timers.size, 0, 'plugin disposal cancels polling')
  harness.visibility('hidden')
  harness.visibility('visible')
  await harness.advance(1_200_000)
  assert.equal(harness.requests.length, 3, 'disposed stores never refresh on visibility events')
}

{
  const harness = lifecycleHarness()
  harness.setInterval(60)
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  await harness.advance(59_999)
  assert.equal(harness.requests.length, 1, 'initial configured interval does not fire early')
  await harness.advance(1)
  assert.equal(harness.requests.length, 2, 'snapshot interval replaces the initial default timer')
  harness.setInterval(300)
  await harness.store.load(false)
  await harness.advance(60_000)
  assert.equal(harness.requests.length, 3, 'increased interval cancels the previous short timer')
  await harness.advance(240_000)
  assert.equal(harness.requests.length, 4, 'increased interval fires at its new deadline')
  harness.setInterval(15)
  await harness.store.load(false)
  await harness.advance(15_000)
  assert.equal(harness.requests.length, 6, 'decreased interval starts without waiting for the old deadline')
  unsubscribe()
  harness.dispose()
}

{
  const harness = lifecycleHarness({ deferSnapshots: true })
  const unsubscribe = harness.store.subscribe(() => {})
  void harness.store.load(false)
  harness.visibility('hidden')
  harness.visibility('visible')
  await harness.advance(1_200_000)
  assert.equal(harness.requests.length, 1, 'mounted polling and visible return coalesce with an in-flight snapshot')
  await harness.store.saveConfig({ refreshSeconds: 60 })
  harness.resolveSnapshot()
  await flush()
  assert.equal(harness.store.get().pollSeconds, 60, 'an older snapshot cannot undo the confirmed refresh setting')
  await harness.advance(60_000)
  assert.equal(harness.requests.length, 2, 'the confirmed interval remains scheduled after the older response')
  // Multiple forced refreshes during one request become exactly one follow-up.
  void harness.store.load(true)
  void harness.store.load(true)
  assert.equal(harness.requests.length, 2, 'manual refresh does not overlap an active snapshot request')
  harness.resolveSnapshot()
  await flush()
  assert.equal(harness.requests.length, 3, 'manual refresh queues one follow-up snapshot')
  assert.ok(harness.requests[2].includes('?refresh=1'), 'the follow-up retains manual refresh semantics')
  harness.resolveSnapshot()
  await flush()
  unsubscribe()
  harness.dispose()
}

for (const outcome of ['success', 'failure']) {
  const harness = lifecycleHarness()
  const original = { orgs: ['old-org'], refreshSeconds: 1200, defaultAgent: 'claude' }
  harness.store.set({ config: original, configStatus: 'ready' })
  const reading = harness.store.loadConfig()
  await harness.store.saveConfig({ orgs: ['new-org'], refreshSeconds: 60, defaultAgent: 'codex' })
  const confirmed = harness.store.get().config
  if (outcome === 'success') harness.resolveConfig(original)
  else harness.rejectConfig(new Error('stale read failed'))
  assert.equal(await reading, confirmed, 'a pre-save read returns the latest confirmed configuration')
  assert.equal(harness.store.get().config, confirmed, 'a pre-save read cannot replace confirmed saved settings')
  assert.equal(harness.store.get().configStatus, 'saved', 'a pre-save read cannot overwrite successful save status')
  assert.equal(harness.store.get().configError, null, 'a pre-save read cannot report a stale error after save success')
  assert.equal(harness.store.get().pollSeconds, 60, 'a pre-save read preserves the confirmed polling interval')
  // A confirmed (200) save reads the normalized config back from the host.
  if (outcome === 'success') {
    const normalized = { ...confirmed, invalidAgents: [] }
    harness.resolveConfig(normalized)
    await flush()
    assert.equal(harness.store.get().config, normalized, 'the post-save read replaces the merged patch')
  } else {
    harness.rejectConfig(new Error('host still restarting'))
    await flush()
    assert.equal(harness.store.get().config, confirmed, 'a failed post-save read keeps the confirmed patch')
    assert.equal(harness.store.get().configError, null, 'a failed post-save read is not reported as an error')
  }
  assert.equal(harness.store.get().configStatus, 'saved', 'the post-save read keeps the saved status')
  const freshRead = harness.store.loadConfig()
  const fresh = { ...harness.store.get().config, orgs: ['external-edit'] }
  harness.resolveConfig(fresh)
  assert.equal(await freshRead, fresh, 'reads started after the save still apply')
  assert.equal(harness.store.get().config, fresh, 'a fresh read can update the confirmed config')
  harness.dispose()
}

for (const host of ['current', 'older']) {
  // A rejected save keeps the host's error detail for the settings form: the
  // current host names the invalid agent, an older one only sends a message.
  const error = host === 'current'
    ? { code: 'invalid-agent', agent: 'claude', message: 'agent "claude" command needs {prompt}' }
    : { code: 'invalid-config', message: 'agent "claude" command needs {prompt}' }
  const harness = lifecycleHarness({ configPost: () => ({ status: 400, payload: { ok: false, error } }) })
  harness.store.set({ config: { orgs: [] }, configStatus: 'ready' })
  await assert.rejects(harness.store.saveConfig({ orgs: ['x'] }), (rejection) => {
    assert.equal(rejection.message, error.message)
    assert.deepEqual(rejection.payload, error, host + ': the rejection carries the host error detail')
    return true
  })
  assert.equal(harness.store.get().configStatus, 'error')
  assert.equal(harness.store.get().configError, error.message)
  assert.deepEqual(harness.store.get().config, { orgs: [] }, host + ': a rejected save leaves the config unchanged')
  harness.dispose()
}

for (const teardown of ['unmount', 'dispose', 'late-unmount', 'late-dispose']) {
  const late = teardown.startsWith('late-')
  const harness = lifecycleHarness({ transientSnapshot: true, deferSnapshots: late })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  if (teardown.endsWith('dispose')) harness.dispose()
  else unsubscribe()
  if (late) {
    harness.resolveSnapshot()
    await flush()
  }
  await harness.advance(3000)
  assert.equal(harness.requests.length, 1, teardown + ': transient recovery must not refresh an unmounted store')
  assert.equal(harness.timers.size, 0, teardown + ': transient recovery must not leave timers after teardown')
  harness.dispose()
}

{
  const harness = lifecycleHarness({ transientSnapshot: true })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  await harness.advance(3000)
  assert.equal(harness.requests.length, 2, 'mounted stores retry a transient snapshot once')
  assert.ok(harness.requests[1].includes('?refresh=1'), 'transient recovery bypasses the snapshot cache')
  await harness.advance(3000)
  assert.equal(harness.requests.length, 2, 'a persistent transient warning does not retry in a loop')
  unsubscribe()
  harness.dispose()
}

/* ------------------------------------------------- snapshot failure backoff */

{
  // Network failures back off 15 s -> 60 s -> 5 min, then wait for the poll.
  let failing = true
  const harness = lifecycleHarness({ outcome: () => (failing ? 'throw' : 'ok') })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.store.get().status, 'error')
  assert.equal(harness.timers.size, 2, 'a failure adds exactly one recovery timer next to the poll')
  await harness.advance(14_999)
  assert.equal(harness.requests.length, 1, 'the first retry waits 15 s')
  await harness.advance(1)
  assert.equal(harness.requests.length, 2, 'first retry after 15 s')
  await harness.advance(60_000)
  assert.equal(harness.requests.length, 3, 'second retry after another 60 s')
  await harness.advance(300_000)
  assert.equal(harness.requests.length, 4, 'third retry after another 5 min')
  assert.equal(harness.timers.size, 1, 'retries are bounded: only the regular poll remains')
  await harness.advance(1_200_000 - 375_000 - 1)
  assert.equal(harness.requests.length, 4, 'no retry loop before the regular poll')
  failing = false
  await harness.advance(1)
  assert.equal(harness.requests.length, 5, 'the regular poll still runs')
  assert.equal(harness.store.get().status, 'ready')
  failing = true
  await harness.advance(1_200_000)
  assert.equal(harness.requests.length, 6)
  await harness.advance(15_000)
  assert.equal(harness.requests.length, 7, 'a successful load resets the backoff to 15 s')
  unsubscribe()
  assert.equal(harness.timers.size, 0, 'unsubscribing cancels a pending failure retry')
  await harness.advance(3_600_000)
  assert.equal(harness.requests.length, 7)
  harness.dispose()
}

for (const result of ['http500', 'error', 'stale']) {
  const harness = lifecycleHarness({ outcome: (n) => (n === 1 ? result : 'ok') })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  await harness.advance(15_000)
  assert.equal(harness.requests.length, 2, result + ': a failed snapshot is retried after 15 s')
  await harness.advance(1_000_000)
  assert.equal(harness.requests.length, 2, result + ': recovery stops after a successful load')
  unsubscribe()
  harness.dispose()
}

{
  // Each backoff step is capped by the poll interval and never races the poll.
  const harness = lifecycleHarness({ outcome: () => 'throw' })
  harness.setInterval(60)
  harness.store.set({ pollSeconds: 60 })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  await harness.advance(15_000)
  assert.equal(harness.requests.length, 2, '15 s retry fits before a 60 s poll')
  assert.equal(harness.timers.size, 1, 'a retry that would not precede the poll is left to the poll')
  await harness.advance(45_000)
  assert.equal(harness.requests.length, 3, 'the poll is the next attempt')
  assert.ok(harness.timers.size <= 2)
  await harness.advance(60_000)
  assert.equal(harness.requests.length, 4, 'one request per poll interval, no doubled attempts')
  unsubscribe()
  harness.dispose()
}

{
  // Hidden tabs skip retries; the visibility handler reloads on return.
  const harness = lifecycleHarness({ outcome: (n) => (n <= 2 ? 'throw' : 'ok') })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  harness.visibility('hidden')
  await harness.advance(400_000)
  assert.equal(harness.requests.length, 1, 'a hidden tab does not retry')
  await harness.store.load(false)
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.timers.size, 1, 'a failure while hidden schedules no retry')
  harness.visibility('visible')
  await flush()
  assert.equal(harness.requests.length, 3, 'returning to the tab reloads immediately')
  assert.equal(harness.store.get().status, 'ready')
  unsubscribe()
  harness.dispose()
}

{
  // A failed transient retry hands over to the backoff without stacking timers.
  const harness = lifecycleHarness({ outcome: () => 'stale-transient' })
  const unsubscribe = harness.store.subscribe(() => {})
  await flush()
  assert.equal(harness.timers.size, 2, 'transient recovery and the poll')
  await harness.advance(3000)
  assert.equal(harness.requests.length, 2, 'transient retry after 3 s')
  assert.equal(harness.timers.size, 2, 'the backoff replaces, not joins, the transient retry')
  await harness.advance(15_000)
  assert.equal(harness.requests.length, 3, 'then the 15 s backoff')
  harness.dispose()
  unsubscribe()
  assert.equal(harness.timers.size, 0, 'disposal cancels the failure retry')
}

{
  // The Workspace UI service often registers after this plugin applied: a
  // one-time ctx.get() missed it and the DSH launch target never appeared.
  // The plugin tracks it through ctx.inject.
  const late = registration.factory(fakeRequire)
  const injections = []
  const slots = []
  late.apply({
    ...fakeCtx,
    get: () => undefined,
    inject: (deps, callback) => { injections.push({ deps, callback }) },
    slots: { inject: (_key, callback) => callback(), register(options) { slots.push(options); return () => {} } },
  })
  const store = slots.find((slot) => slot.name === 'main').inject().store
  assert.deepEqual(injections.map((entry) => entry.deps), [['uiWorkspace']], 'the plugin asks for uiWorkspace through ctx.inject')
  assert.notEqual(store.get().dshAvailable, true, 'no DSH target before the service exists')
  const scopeDisposers = []
  injections[0].callback({ uiWorkspace: { startSession() {} }, effect: (callback) => { scopeDisposers.push(callback()) } })
  assert.equal(store.get().dshAvailable, true, 'the service arriving later enables the DSH target')
  for (const dispose of scopeDisposers) dispose()
  assert.equal(store.get().dshAvailable, false, 'losing the service hides the DSH target again')
  store.dispose()
}

console.log('client smoke OK')
