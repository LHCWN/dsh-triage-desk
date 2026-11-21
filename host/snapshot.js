/**
 * Triage Desk — snapshot build wired to the cache: adaptive TTL from the
 * reported rate limit, per-source profiles kept between builds, a failed
 * build served as the previous snapshot marked `stale` (with
 * `meta.lastError`), and lookups of cached rows by URL.
 */

import { buildSnapshot, snapshotSettings, SECTION_IDS, GhError } from '../github.js'
import { createSnapshotCache, shouldCacheSnapshot } from './snapshot-cache.js'

/**
 * `previous` is the store a settings save replaced. Until this store caches
 * its first build, its snapshot is the fallback: a failed build serves it
 * marked `stale` (reporting the saved settings), and row lookups read it.
 */
export function createSnapshotStore({ ctx, settings, resolveGh, log: safeLog, previous }) {
  let lastSnapshot = null
  let inherited = previous === undefined ? null : previous.fallbackSnapshot()

  let cache = null
  let adaptiveTtlMs = settings.ttlMs
  // What builds learned about each source (its lighter pull level, whether it
  // is large). Per store, so a change of the GitHub settings (a new store)
  // starts every source over.
  const profiles = new Map()

  const build = async () => {
    await resolveGh()
    try {
      const snapshot = await buildSnapshot(ctx, settings, { profiles })
      lastSnapshot = snapshot
      const remaining =
        snapshot && snapshot.meta && snapshot.meta.rateLimit ? snapshot.meta.rateLimit.remaining : null
      adaptiveTtlMs =
        typeof remaining === 'number' && remaining < 1500
          ? Math.min(3_600_000, Math.max(settings.ttlMs * 2, 900_000))
          : settings.ttlMs
      return snapshot
    } catch (error) {
      const code = error instanceof GhError ? error.code : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      const previous = fallbackSnapshot()
      if (previous !== null) {
        return {
          ...previous,
          // An inherited snapshot was built for the replaced settings.
          settings: snapshotSettings(settings),
          status: 'stale',
          warnings: [
            ...(Array.isArray(previous.warnings) ? previous.warnings : []),
            { code, message: `refresh failed, showing the previous snapshot: ${message}` },
          ],
          meta: { ...(previous.meta || {}), lastError: { code, message } },
        }
      }
      safeLog('warn', 'snapshot failed: %s', message)
      return {
        ok: false,
        status: 'error',
        generatedAt: new Date().toISOString(),
        sources: [],
        orgs: settings.orgs,
        org: '',
        user: null,
        counts: { ...Object.fromEntries(SECTION_IDS.map((id) => [id, 0])), total: 0 },
        sections: SECTION_IDS.map((id) => ({ id, items: [] })),
        warnings: [],
        error: { code: `gh-${code}`, message },
        settings: snapshotSettings(settings),
        meta: { durationMs: 0, rateLimit: null },
      }
    }
  }

  cache = createSnapshotCache(build, () => adaptiveTtlMs, shouldCacheSnapshot)

  /** The cached snapshot, else the one inherited from `previous`, else null. */
  const fallbackSnapshot = () => {
    const own = cache === null ? null : cache.peek()
    if (own === null || own === undefined) return inherited
    inherited = null
    return own
  }

  /** Snapshot row for a URL, restricted to the originating group for a batch. */
  const findSnapshotEntry = (url, sectionId) => {
    const snapshot = fallbackSnapshot()
    if (snapshot === null || !Array.isArray(snapshot.sections)) return null
    for (const section of snapshot.sections) {
      if (sectionId && section?.id !== sectionId) continue
      for (const item of (section && section.items) || []) {
        if (item && item.url === url) return { section: section.id, item }
      }
    }
    return null
  }

  return { cache, lastSnapshot: () => lastSnapshot, fallbackSnapshot, findSnapshotEntry }
}
