/**
 * Triage Desk — plain-text rendering of a snapshot for the `triage_desk` tool.
 */

import { SECTION_IDS } from '../github.js'

/** "just now", "12 min ago", "3 h ago", "2 d ago" between an ISO time and `now`. */
export function snapshotAge(generatedAt, now = Date.now()) {
  const at = Date.parse(generatedAt)
  if (!Number.isFinite(at)) return ''
  const minutes = Math.floor(Math.max(0, now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/**
 * `wanted` is the set of requested section ids, or null for all. `now` is for
 * tests. The text separates an empty snapshot from requested sections that
 * are empty while others are not, and says when the data is stale or partial.
 */
export function formatToolText(snapshot, wanted, now = Date.now()) {
  if (snapshot === null || snapshot === undefined) return 'No snapshot is available yet.'
  if (snapshot.status === 'error' && snapshot.error) {
    return `GitHub attention snapshot failed: ${snapshot.error.code} — ${snapshot.error.message}`
  }
  const lines = []
  const counts = snapshot.counts || {}
  const sources = Array.isArray(snapshot.sources) ? snapshot.sources : []
  const sourceLabel = (source) => (source.kind === 'user' ? 'personal' : source.login)
  const header = sources.length > 0 ? sources.map(sourceLabel).join(' + ') : 'no sources'
  const age = snapshotAge(snapshot.generatedAt, now)
  lines.push(`Triage Desk — ${header} — ${counts.total || 0} item(s) at ${snapshot.generatedAt}${age ? ` (${age})` : ''}`)
  const parts = []
  for (const id of SECTION_IDS) parts.push(`${id}: ${counts[id] || 0}`)
  lines.push(parts.join(' · '))
  // A stale snapshot carries the failed refresh in meta.lastError; a partial
  // one names its unreadable sources in the warnings below.
  if (snapshot.status === 'stale') {
    const reason = snapshot.meta?.lastError?.message || 'the latest refresh failed'
    lines.push(`Status: stale — ${reason} (snapshot from ${snapshot.generatedAt})`)
  } else if (snapshot.status === 'partial') {
    lines.push('Status: partial — some sources could not be read')
  }
  let printed = 0
  let elsewhere = 0
  for (const section of snapshot.sections || []) {
    const items = section.items
    if (wanted !== null && !wanted.has(section.id)) {
      elsewhere += items.length
      continue
    }
    if (items.length === 0) continue
    lines.push('')
    lines.push(`## ${section.id} (${items.length})`)
    for (const item of items) {
      printed += 1
      const number = item.kind === 'branch' ? item.ref : `#${item.number}`
      const label = item.kind === 'branch' ? 'branch checks' : item.title
      const tag = item.source ? `[${sourceLabel(item.source)}] ` : ''
      lines.push(`- ${tag}${item.repo} ${number} — ${label} [${item.reason}] ${item.url}`)
    }
  }
  if (printed === 0) {
    lines.push('', elsewhere > 0
      ? `Nothing in the requested sections; ${elsewhere} item(s) are in other sections.`
      : 'Nothing needs your attention right now.')
  }
  // The Status line already reports a stale snapshot's failed refresh, so its
  // warning (same code, same message) is not repeated.
  const lastError = snapshot.status === 'stale' ? snapshot.meta?.lastError : null
  const warnings = (Array.isArray(snapshot.warnings) ? snapshot.warnings : []).filter((entry) =>
    !(lastError && entry.code === lastError.code && String(entry.message).includes(lastError.message)))
  // Coverage limits (kind 'limit') bound what was read; other warnings are
  // data that failed to load.
  const limits = warnings.filter((entry) => entry.kind === 'limit')
  const problems = warnings.filter((entry) => entry.kind !== 'limit')
  if (problems.length > 0) lines.push('', `Warnings: ${problems.map((entry) => entry.message).join('; ')}`)
  if (limits.length > 0) lines.push('', `Limits: ${limits.map((entry) => entry.message).join('; ')}`)
  return lines.join('\n')
}
