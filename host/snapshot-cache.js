/**
 * Triage Desk — snapshot cache and cache policy.
 *
 * A single-flight, TTL-bound cache around the snapshot build, plus the rule
 * that decides which built snapshots may be cached. Pure: no Cordis services.
 */

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Settle with `promise`, or reject early when this caller's `signal` aborts.
 * The shared build keeps running for the other readers and the cache.
 */
export function raceAbort(promise, signal) {
  if (signal === undefined || signal === null) return promise
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error('the snapshot read was cancelled')
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function createSnapshotCache(build, ttlMs, cacheable) {
  let state = { at: 0, snapshot: null }
  let inflight = null
  let queuedForce = false
  const shouldCache = typeof cacheable === 'function' ? cacheable : () => true
  const ttl = () => (typeof ttlMs === 'function' ? ttlMs() : ttlMs)
  // `signal` cancels only this caller's wait. It is never forwarded into the
  // shared build: one cancelled tool call must not fail every `gh` call of a
  // build that other readers are waiting on (and that then gets cached).
  const read = (force, signal) => {
    // An already-cancelled caller must not start a build nobody waits for.
    if (signal !== undefined && signal !== null && signal.aborted) return raceAbort(Promise.resolve(null), signal)
    const fresh = state.snapshot !== null && Date.now() - state.at < ttl()
    if (!force && fresh) return Promise.resolve(state.snapshot)
    if (inflight !== null) {
      // Keep the forced request instead of silently returning the cached build.
      if (force === true) queuedForce = true
      return raceAbort(inflight, signal)
    }
    inflight = Promise.resolve()
      .then(() => build())
      .then((snapshot) => {
        // Do not pin a failure for the whole success TTL: the next request
        // should retry GitHub instead of replaying the error.
        if (shouldCache(snapshot)) state = { at: Date.now(), snapshot }
        return snapshot
      })
      .finally(() => {
        inflight = null
        if (queuedForce) {
          queuedForce = false
          void read(true)
        }
      })
    return raceAbort(inflight, signal)
  }
  return { read, peek: () => state.snapshot }
}

/* -------------------------------------------------------------------------- */
/* Cache policy                                                               */
/* -------------------------------------------------------------------------- */

const TRANSIENT_WARNING_PATTERN = /inactive context|cannot get required service/i

/**
 * True when a partial snapshot failed because the plugin's services were torn
 * down mid-build (a reload), not because GitHub itself failed. Such snapshots
 * must not be cached: a retry after the reload has to reach GitHub again.
 */
export function hasTransientWarnings(snapshot) {
  if (snapshot === null || snapshot === undefined) return false
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : []
  return warnings.some(
    (entry) => entry !== null && entry !== undefined && TRANSIENT_WARNING_PATTERN.test(String(entry.message || '')),
  )
}

export function shouldCacheSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) return false
  if (snapshot.status !== 'ok' && snapshot.status !== 'partial') return false
  if (snapshot.status === 'partial' && hasTransientWarnings(snapshot)) return false
  return true
}
