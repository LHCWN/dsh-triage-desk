/**
 * Dev smoke test for the host snapshot cache: successful snapshots are cached,
 * failures are not, forced refreshes are queued instead of dropped (unless the
 * cache was retired), and the TTL can be supplied by a function (used for the
 * low-quota adaptive TTL).
 * Run with `npm run smoke:cache`. Not shipped in the npm package.
 */
import assert from 'node:assert/strict'
import { createSnapshotCache, shouldCacheSnapshot } from '../index.js'

const checks = []
async function check(name, callback) {
  try {
    await callback()
    checks.push({ name, ok: true })
    console.log('ok   ' + name)
  } catch (error) {
    checks.push({ name, ok: false, error })
    console.error('FAIL ' + name + ': ' + error.message)
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
const okSnapshot = { status: 'ok' }

await check('successful snapshots are cached and force rebuilds', async () => {
  let builds = 0
  const cache = createSnapshotCache(
    async () => {
      builds += 1
      return okSnapshot
    },
    60_000,
    (snapshot) => snapshot.status === 'ok',
  )
  await cache.read(false)
  await cache.read(false)
  assert.equal(builds, 1)
  await cache.read(true)
  assert.equal(builds, 2)
})

await check('failures are not cached for the success TTL', async () => {
  let builds = 0
  const cache = createSnapshotCache(
    async () => {
      builds += 1
      return { status: 'error' }
    },
    60_000,
    (snapshot) => snapshot.status === 'ok' || snapshot.status === 'partial',
  )
  await cache.read(false)
  await cache.read(false)
  assert.equal(builds, 2, 'the second read should retry GitHub')
})

await check('stale snapshots are not cached either', async () => {
  let builds = 0
  const cache = createSnapshotCache(
    async () => {
      builds += 1
      return { status: 'stale' }
    },
    60_000,
    (snapshot) => snapshot.status === 'ok' || snapshot.status === 'partial',
  )
  await cache.read(false)
  await cache.read(false)
  assert.equal(builds, 2)
})

await check('a forced read during an in-flight build is queued', async () => {
  let builds = 0
  let release
  const cache = createSnapshotCache(
    () => {
      builds += 1
      if (builds === 1) {
        return new Promise((resolve) => {
          release = resolve
        })
      }
      return Promise.resolve(okSnapshot)
    },
    60_000,
    () => true,
  )
  const first = cache.read(false)
  const forced = cache.read(true)
  assert.equal(forced, first, 'the in-flight promise is returned')
  await tick()
  release(okSnapshot)
  await first
  await tick()
  await tick()
  assert.equal(builds, 2, 'the queued forced refresh should start after the first build')
  await cache.read(false)
})

await check('a retired cache drops the forced read queued during its last build', async () => {
  let builds = 0
  let release
  const cache = createSnapshotCache(
    () => {
      builds += 1
      return new Promise((resolve) => {
        release = resolve
      })
    },
    60_000,
    () => true,
  )
  const first = cache.read(false)
  void cache.read(true)
  cache.retire()
  await tick()
  release(okSnapshot)
  assert.equal(await first, okSnapshot, 'the in-flight build still answers its readers')
  await tick()
  assert.equal(builds, 1, 'no rebuild is queued for a cache nobody reads')
})

await check('the TTL can be read from a function', async () => {
  let builds = 0
  let ttlCalls = 0
  let ttl = 0
  const cache = createSnapshotCache(
    async () => {
      builds += 1
      return okSnapshot
    },
    () => {
      ttlCalls += 1
      return ttl
    },
    () => true,
  )
  await cache.read(false)
  await cache.read(false)
  assert.equal(builds, 2, 'a zero TTL should not serve a stale cached value')
  ttl = 60_000
  await cache.read(false)
  assert.equal(builds, 2, 'a longer TTL should serve the cached value')
  assert.ok(ttlCalls >= 2, 'the TTL function is consulted on cached reads')
})

await check('a snapshot torn down mid-build is not cached', async () => {
  const tornDown = {
    status: 'partial',
    warnings: [
      { message: 'devnullexile: issue search failed: gh could not start: cannot get required service "subprocess" in inactive context' },
    ],
  }
  assert.equal(shouldCacheSnapshot(okSnapshot), true, 'complete snapshots are cacheable')
  assert.equal(shouldCacheSnapshot({ status: 'error' }), false, 'errors are not cacheable')
  assert.equal(
    shouldCacheSnapshot({ status: 'partial', warnings: [{ message: 'rate limit exhausted' }] }),
    true,
    'ordinary partial snapshots keep their TTL',
  )
  assert.equal(shouldCacheSnapshot(tornDown), false, 'a torn-down build must be retried')
  let builds = 0
  const cache = createSnapshotCache(
    async () => {
      builds += 1
      return builds === 1 ? tornDown : okSnapshot
    },
    60_000,
    shouldCacheSnapshot,
  )
  const first = await cache.read(false)
  assert.equal(first.status, 'partial')
  const second = await cache.read(false)
  assert.equal(second.status, 'ok')
  assert.equal(builds, 2, 'the transient partial must not be served from the cache')
})

const failed = checks.filter((entry) => entry.ok === false)
console.log(`\n${checks.length - failed.length}/${checks.length} cache checks passed`)
if (failed.length > 0) {
  console.error(failed.map((entry) => entry.name).join(', '))
  process.exitCode = 1
} else {
  console.log('cache smoke OK')
}
