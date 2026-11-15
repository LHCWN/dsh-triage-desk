/**
 * Triage Desk — snapshot build wired to the cache: adaptive TTL from the
 * reported rate limit, a failed build served as the previous snapshot marked
 * `stale` (with `meta.lastError`), and lookups of cached rows by URL.
 */

import { buildSnapshot, SECTION_IDS, GhError } from '../github.js'
import { createSnapshotCache, shouldCacheSnapshot } from './snapshot-cache.js'

export function createSnapshotStore({ ctx, settings, resolveGh, log: safeLog }) {
  let lastSnapshot = null

  let cache = null
  let adaptiveTtlMs = settings.ttlMs

  const build = async () => {
    await resolveGh()
    try {
      const snapshot = await buildSnapshot(ctx, settings)
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
      const previous = cache === null ? null : cache.peek()
      if (previous !== null && previous !== undefined) {
        return {
          ...previous,
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
        counts: { review: 0, rereview: 0, merge: 0, respond: 0, ci: 0, issues: 0, total: 0 },
        sections: SECTION_IDS.map((id) => ({ id, items: [] })),
        warnings: [],
        error: { code: `gh-${code}`, message },
        settings: {
          orgs: settings.orgs,
          includePersonal: settings.includePersonal,
          sourcesAuto: settings.orgs.length === 0,
          refreshSeconds: settings.refreshSeconds,
          requireGreenChecks: settings.requireGreenChecks,
          includeBotReviews: settings.includeBotReviews,
        },
        meta: { durationMs: 0, rateLimit: null },
      }
    }
  }

  cache = createSnapshotCache(build, () => adaptiveTtlMs, shouldCacheSnapshot)

  /** Snapshot row for an exact URL, with its section id, or null. */
  const findSnapshotEntry = (url) => {
    const snapshot = cache.peek()
    if (snapshot === null || snapshot === undefined || !Array.isArray(snapshot.sections)) return null
    for (const section of snapshot.sections) {
      for (const item of (section && section.items) || []) {
        if (item && item.url === url) return { section: section.id, item }
      }
    }
    return null
  }

  return { cache, lastSnapshot: () => lastSnapshot, findSnapshotEntry }
}
